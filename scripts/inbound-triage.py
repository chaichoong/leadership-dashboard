#!/usr/bin/env python3
"""Inbound Comms Triage agent — transport and state for the daily email triage.

WHY THIS EXISTS
The triage agent (AI Agents register row recYy33zkoa099uM2) sorts Kevin's
inbox every morning: actionable emails become labelled, agent-routed tasks;
machine noise is archived; nothing is ever sent, replied to, or deleted. The
JUDGEMENT lives in the skill (~/.claude/scheduled-tasks/inbound-email-triage/
SKILL.md) and in the agent's compiled prompt. This script is the mechanics:

  * talks to the drive-upload worker's /gmail/* endpoints (the only headless
    path into Gmail — the browser page needs Kevin's session);
  * keeps the watermark so each run picks up where the last one stopped;
  * appends every decision to a PRIVATE digest log, so a wrong call is
    auditable and reversible (the repo is public; message content must never
    reach monitoring/ or any committed file);
  * writes the agent's Metric Score ("N waiting; at zero X of last 7 days")
    to its own register row, per the AGENTIC Conclusion & Score stage.

The worker endpoints can label and archive, never send, delete, or mark spam
(enforced worker-side too). Archive = remove from inbox; the email stays in
All Mail and every label it carries, so every action here is reversible.

USAGE
  inbound-triage.py labels                    resolve the triage labels (8/12/13)
  inbound-triage.py scan [--back-hours N]     JSON: new inbox mail since the
                                              watermark (re-reads N hours behind
                                              it, default 12), stale inbox mail
                                              older than 2 days, and everything
                                              on labels 8/12 from the last 14
                                              days (for the stranded-task check)
  inbound-triage.py act --id MSGID --do label8|label12|label13|archive
                        [--reason R] [--sender S] [--subject SUBJ]
                                              apply one triage decision + log it
  inbound-triage.py note --id MSGID --do leave|task-created|duplicate|deferred
                        [--reason R] [--sender S] [--subject SUBJ]
                                              log a no-Gmail-change decision
  inbound-triage.py mark --upto MS            advance the watermark (epoch ms)
  inbound-triage.py score --waiting N         record today's waiting count and
                                              write Metric Score to the register
  inbound-triage.py selftest                  offline checks of the pure helpers

SECRETS: worker key at ~/.config/od/gmail_send_key, Airtable PAT at
~/.config/od/airtable_pat. Read from file, never printed, never in argv.
"""

import json
import os
import re
import sys
import tempfile
import urllib.error
import urllib.request
from datetime import date, datetime, timedelta
from pathlib import Path

WORKER_URL = "https://drive-upload.kevinbrittain.workers.dev"
GMAIL_KEY_FILE = Path.home() / ".config/od/gmail_send_key"
AIRTABLE_PAT_FILE = Path.home() / ".config/od/airtable_pat"

AIRTABLE_BASE = "appnqjDpqDniH3IRl"
AGENTS_TABLE = "tbl9msVjyQWslLOIZ"
TRIAGE_AGENT_ROW = "recYy33zkoa099uM2"   # "Inbound Comms Triage" in AI Agents
METRIC_SCORE_FIELD = "fldkGxrOlrfuLlH3J"  # singleLineText — current reading

# State + digest live OUTSIDE the repo: the repo is public and the digest holds
# senders and subjects. INBOUND_TRIAGE_DIR exists so selftest can use a tempdir.
def base_dir():
    return Path(os.environ.get("INBOUND_TRIAGE_DIR") or (Path.home() / "knowledge-os/logs/inbound-triage"))


# ---------------------------------------------------------------------------
# Pure helpers (covered by selftest)
# ---------------------------------------------------------------------------

def gmail_query_name(label_name):
    """Gmail search syntax for a label name: spaces become hyphens.
    "8: task created" → "8:-task-created" (the form the Gmail routines have
    always used and Gmail accepts)."""
    return label_name.replace(" ", "-")


def find_label(labels, prefix):
    """First label whose name starts "<prefix>: " or "<prefix>. " — the same
    prefix convention follow-up.html matches with /^8[.:]\\s/."""
    pat = re.compile(r"^%s[.:]\s" % re.escape(prefix))
    for l in labels:
        if pat.match(l.get("name", "")):
            return l
    return None


def metric_string(history, today_iso):
    """"N waiting; at zero X of last 7 days" from the history map
    {YYYY-MM-DD: waiting}. X counts only RECORDED zero days among the 7
    calendar days ending today — a day with no record is a day the run did not
    happen, and absence must never read as success."""
    waiting = history.get(today_iso)
    if waiting is None:
        raise ValueError("no reading recorded for today")
    d = date.fromisoformat(today_iso)
    zero_days = 0
    for i in range(7):
        v = history.get((d - timedelta(days=i)).isoformat())
        if v == 0:
            zero_days += 1
    return "%d waiting; at zero %d of last 7 days" % (waiting, zero_days)


def next_watermark(max_ms, unhandled_ms_list):
    """Watermark rule (same as the iMessage sweep): advance to max_ms only when
    everything seen was handled. Any deferred or failed item pins the watermark
    just before the OLDEST of them, so tomorrow's scan sees it again. A
    watermark that passes an untasked message loses it for good."""
    if not unhandled_ms_list:
        return max_ms
    return min(unhandled_ms_list) - 1


def trim_history(history, keep_days=30, today=None):
    d = today or date.today()
    cutoff = (d - timedelta(days=keep_days)).isoformat()
    return {k: v for k, v in history.items() if k >= cutoff}


# ---------------------------------------------------------------------------
# State + digest
# ---------------------------------------------------------------------------

def read_state():
    p = base_dir() / "state.json"
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text())
    except (json.JSONDecodeError, OSError) as e:
        # A corrupt state file must be loud: silently restarting the watermark
        # would re-create a week of tasks (dedupe is the only guard left).
        fail("state file unreadable at %s: %s" % (p, e))


def write_state(state):
    d = base_dir()
    d.mkdir(parents=True, exist_ok=True)
    tmp = d / "state.json.tmp"
    tmp.write_text(json.dumps(state, indent=1, sort_keys=True))
    tmp.rename(d / "state.json")


def digest_append(entry):
    d = base_dir()
    d.mkdir(parents=True, exist_ok=True)
    entry = dict(entry, ts=datetime.now().isoformat(timespec="seconds"))
    p = d / ("digest-%s.jsonl" % date.today().isoformat())
    with open(p, "a") as f:
        f.write(json.dumps(entry) + "\n")


# ---------------------------------------------------------------------------
# Transport
# ---------------------------------------------------------------------------

def fail(msg):
    print(json.dumps({"error": msg}))
    sys.exit(2)


def read_secret(path, what):
    try:
        return path.read_text().strip()
    except OSError:
        fail("cannot read %s at %s" % (what, path))


def worker_post(path, payload):
    key = read_secret(GMAIL_KEY_FILE, "gmail worker key")
    req = urllib.request.Request(
        WORKER_URL + path,
        data=json.dumps(payload).encode(),
        headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as res:
            return json.loads(res.read().decode())
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")[:500]
        if e.code == 409:
            fail("Gmail not connected on the worker (409). Kevin grants once at "
                 "%s/auth/gmail — then retry. Detail: %s" % (WORKER_URL, body))
        fail("worker %s answered %d: %s" % (path, e.code, body))
    except (urllib.error.URLError, TimeoutError) as e:
        fail("worker %s unreachable: %s" % (path, e))


def worker_labels():
    return worker_post("/gmail/labels", {}).get("labels", [])


def worker_list(q, max_results=25):
    return worker_post("/gmail/list", {"q": q, "maxResults": max_results}).get("messages", [])


def airtable_patch_metric(text):
    pat = read_secret(AIRTABLE_PAT_FILE, "Airtable PAT")
    req = urllib.request.Request(
        "https://api.airtable.com/v0/%s/%s/%s" % (AIRTABLE_BASE, AGENTS_TABLE, TRIAGE_AGENT_ROW),
        data=json.dumps({"fields": {METRIC_SCORE_FIELD: text}}).encode(),
        headers={"Authorization": "Bearer " + pat, "Content-Type": "application/json"},
        method="PATCH",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            return json.loads(res.read().decode())
    except urllib.error.HTTPError as e:
        fail("register Metric Score write failed (%d): %s" % (e.code, e.read().decode(errors="replace")[:300]))
    except (urllib.error.URLError, TimeoutError) as e:
        fail("Airtable unreachable writing Metric Score: %s" % e)


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

def resolve_triage_labels():
    labels = worker_labels()
    l8 = find_label(labels, "8")
    l12 = find_label(labels, "12")
    l13 = find_label(labels, "13")
    if not l8 or not l12:
        fail("triage labels missing: found 8=%s 12=%s — the lanes the whole "
             "routing depends on. Do not continue; report this."
             % (l8 and l8["name"], l12 and l12["name"]))
    return l8, l12, l13


def cmd_labels():
    l8, l12, l13 = resolve_triage_labels()
    print(json.dumps({"label8": l8, "label12": l12, "label13": l13}, indent=1))


def cmd_scan(back_hours):
    l8, l12, l13 = resolve_triage_labels()
    state = read_state()
    now_ms = int(datetime.now().timestamp() * 1000)
    first_run = "watermark_ms" not in state
    wm = state.get("watermark_ms", now_ms - 7 * 86400 * 1000)
    after_s = max(0, wm // 1000 - back_hours * 3600)

    new_inbox = worker_list("in:inbox -in:chats after:%d" % after_s)
    stale = worker_list("in:inbox -in:chats older_than:2d")
    stranded_8 = worker_list("label:%s newer_than:14d" % gmail_query_name(l8["name"]))
    stranded_12 = worker_list("label:%s newer_than:14d" % gmail_query_name(l12["name"]))

    print(json.dumps({
        "watermark_ms": wm,
        "first_run": first_run,
        "now_ms": now_ms,
        "labels": {"label8": l8["name"], "label12": l12["name"],
                   "label13": l13["name"] if l13 else None},
        "counts": {"new_inbox": len(new_inbox), "stale": len(stale),
                   "stranded_8": len(stranded_8), "stranded_12": len(stranded_12)},
        "new_inbox": new_inbox,
        "stale": stale,
        "stranded_8": stranded_8,
        "stranded_12": stranded_12,
    }))


ACT_LABEL = {"label8": "8", "label12": "12", "label13": "13"}


def cmd_act(msg_id, action, reason, sender, subject):
    if action == "archive":
        add, remove = [], ["INBOX"]
    elif action in ACT_LABEL:
        l8, l12, l13 = resolve_triage_labels()
        chosen = {"label8": l8, "label12": l12, "label13": l13}[action]
        if not chosen:
            fail("label for %s not found in Gmail" % action)
        # Gmail's "move to label": add the label, take it out of the inbox —
        # exactly what Kevin's manual move does.
        add, remove = [chosen["name"]], ["INBOX"]
    else:
        fail("unknown action %r" % action)
    result = worker_post("/gmail/modify", {"ids": [msg_id], "addLabels": add, "removeLabels": remove})
    digest_append({"id": msg_id, "do": action, "sender": sender, "subject": subject, "reason": reason})
    print(json.dumps({"done": action, "id": msg_id, "modified": result.get("modified")}))


def cmd_note(msg_id, action, reason, sender, subject):
    if action not in ("leave", "task-created", "duplicate", "deferred"):
        fail("unknown note %r" % action)
    digest_append({"id": msg_id, "do": action, "sender": sender, "subject": subject, "reason": reason})
    print(json.dumps({"noted": action, "id": msg_id}))


def cmd_mark(upto_ms):
    state = read_state()
    state["watermark_ms"] = int(upto_ms)
    write_state(state)
    print(json.dumps({"watermark_ms": state["watermark_ms"]}))


def cmd_score(waiting):
    state = read_state()
    history = state.get("history", {})
    today = date.today().isoformat()
    history[today] = int(waiting)
    state["history"] = trim_history(history)
    write_state(state)
    text = metric_string(state["history"], today)
    airtable_patch_metric(text)
    print(json.dumps({"metric_score": text, "written_to_register": True}))


# ---------------------------------------------------------------------------
# Selftest (offline — no network, no real state dir)
# ---------------------------------------------------------------------------

def selftest():
    failures = []

    def check(name, cond):
        if not cond:
            failures.append(name)
            print("FAIL %s" % name)

    check("query name hyphens", gmail_query_name("8: task created") == "8:-task-created")
    check("query name plain", gmail_query_name("12: Kevin to respond") == "12:-Kevin-to-respond")

    labels = [{"id": "La", "name": "8: task created"}, {"id": "Lb", "name": "12: Kevin to respond"},
              {"id": "Lc", "name": "13: Maintenance"}, {"id": "Ld", "name": "128: decoy"}]
    check("find 8", find_label(labels, "8")["id"] == "La")
    check("find 12", find_label(labels, "12")["id"] == "Lb")
    check("find 13", find_label(labels, "13")["id"] == "Lc")
    check("no prefix over-match", find_label(labels, "1") is None)

    today = date.today()
    hist = {today.isoformat(): 0}
    for i in (1, 2, 3):
        hist[(today - timedelta(days=i)).isoformat()] = 0
    hist[(today - timedelta(days=4)).isoformat()] = 2
    # days 5 and 6 unrecorded — must NOT count as zero
    check("metric counts recorded zeros only",
          metric_string(hist, today.isoformat()) == "0 waiting; at zero 4 of last 7 days")
    hist[today.isoformat()] = 3
    check("metric shows waiting", metric_string(hist, today.isoformat()).startswith("3 waiting; at zero 3 "))
    try:
        metric_string({}, today.isoformat())
        check("metric refuses missing today", False)
    except ValueError:
        pass

    check("watermark advances clean", next_watermark(1000, []) == 1000)
    check("watermark pins to oldest unhandled", next_watermark(1000, [800, 400]) == 399)

    trimmed = trim_history({"2020-01-01": 1, today.isoformat(): 0}, keep_days=30, today=today)
    check("history trims old days", "2020-01-01" not in trimmed and today.isoformat() in trimmed)

    with tempfile.TemporaryDirectory() as tmp:
        os.environ["INBOUND_TRIAGE_DIR"] = tmp
        try:
            write_state({"watermark_ms": 42})
            check("state roundtrip", read_state()["watermark_ms"] == 42)
            digest_append({"id": "m1", "do": "archive", "reason": "newsletter"})
            digest_file = next(Path(tmp).glob("digest-*.jsonl"))
            row = json.loads(digest_file.read_text().splitlines()[0])
            check("digest has decision", row["do"] == "archive" and "ts" in row)
        finally:
            del os.environ["INBOUND_TRIAGE_DIR"]

    if failures:
        print("selftest FAILED: %d" % len(failures))
        sys.exit(1)
    print("selftest OK")


# ---------------------------------------------------------------------------

def main(argv):
    if not argv:
        print(__doc__)
        sys.exit(1)

    def opt(flag, default=None):
        if flag in argv:
            return argv[argv.index(flag) + 1]
        return default

    cmd = argv[0]
    if cmd == "labels":
        cmd_labels()
    elif cmd == "scan":
        cmd_scan(int(opt("--back-hours", "12")))
    elif cmd == "act":
        msg_id = opt("--id")
        action = opt("--do")
        if not msg_id or not action:
            fail("act needs --id and --do")
        cmd_act(msg_id, action, opt("--reason", ""), opt("--sender", ""), opt("--subject", ""))
    elif cmd == "note":
        msg_id = opt("--id")
        action = opt("--do")
        if not msg_id or not action:
            fail("note needs --id and --do")
        cmd_note(msg_id, action, opt("--reason", ""), opt("--sender", ""), opt("--subject", ""))
    elif cmd == "mark":
        upto = opt("--upto")
        if not upto:
            fail("mark needs --upto <epoch ms>")
        cmd_mark(upto)
    elif cmd == "score":
        waiting = opt("--waiting")
        if waiting is None:
            fail("score needs --waiting <count>")
        cmd_score(waiting)
    elif cmd == "selftest":
        selftest()
    else:
        fail("unknown command %r" % cmd)


if __name__ == "__main__":
    main(sys.argv[1:])
