#!/usr/bin/env python3
"""Inbound Comms Triage agent — transport and state for the daily email triage.

WHY THIS EXISTS
The triage agent (AI Agents register row recYy33zkoa099uM2) sorts Kevin's
inbox every morning: actionable emails become agent-routed tasks with Kevin as
the initial approver, machine noise is archived, and nothing is ever sent,
replied to, or deleted. The JUDGEMENT lives in the skill
(~/.claude/scheduled-tasks/inbound-email-triage/SKILL.md) and in the agent's
compiled prompt. This script is the mechanics:

  * talks to the drive-upload worker's /gmail/* endpoints (the only headless
    path into Gmail — the browser page needs Kevin's session). Those
    endpoints hold a TRIAGE-ONLY key: it can read and label, never send;
  * keeps the watermark so each run picks up where the last one stopped, and
    reports TRUNCATION honestly — a capped listing must never let the
    watermark advance past mail nobody saw;
  * caches each scan's sender/subject per message id, so later `act` calls
    never take email-controlled text as command-line input (a subject line is
    attacker-controlled; it must never pass through a shell);
  * appends every decision to a PRIVATE digest log, so a wrong call is
    auditable and reversible (the repo is public; message content must never
    reach monitoring/ or any committed file);
  * writes the agent's Metric Score ("N waiting; at zero X of last 7 days")
    to its own register row, per the AGENTIC Conclusion & Score stage.

Archive = remove from inbox; the email keeps every label and stays in All
Mail, so every action here is reversible.

USAGE
  inbound-triage.py labels                    every Gmail label (id + name),
                                              with the triage lanes resolved
  inbound-triage.py scan [--back-hours N]     JSON: new inbox mail since the
                                              watermark (re-reading N hours
                                              behind it, default 12), stale
                                              inbox mail older than 2 days, and
                                              everything on the source labels
                                              from the last 14 days (stranded
                                              check). Each list carries a
                                              `truncated` flag — see Step 6 of
                                              the skill for what that forbids.
  inbound-triage.py act --id MSGID --do label12|label13|archive [--reason R]
                                              apply one triage decision + log
                                              it (sender/subject come from the
                                              scan cache, never from argv)
  inbound-triage.py note --id MSGID --do leave|task-created|duplicate|deferred [--reason R]
                                              log a no-Gmail-change decision
  inbound-triage.py mark --upto MS            advance the watermark (epoch ms)
  inbound-triage.py score --waiting N         record today's waiting count and
                                              write Metric Score to the register
  inbound-triage.py selftest                  offline checks of the pure helpers

SECRETS: triage worker key at ~/.config/od/gmail_triage_key (read/label only,
distinct from the send key by design), Airtable PAT at
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
TRIAGE_KEY_FILE = Path.home() / ".config/od/gmail_triage_key"
AIRTABLE_PAT_FILE = Path.home() / ".config/od/airtable_pat"

AIRTABLE_BASE = "appnqjDpqDniH3IRl"
AGENTS_TABLE = "tbl9msVjyQWslLOIZ"
TRIAGE_AGENT_ROW = "recYy33zkoa099uM2"   # "Inbound Comms Triage" in AI Agents
METRIC_SCORE_FIELD = "fldkGxrOlrfuLlH3J"  # singleLineText — current reading

# One list call returns at most 25 (the worker's subrequest budget); we follow
# nextPageToken up to this many pages per query, then report truncated=True.
MAX_PAGES = 4

# State + digest live OUTSIDE the repo: the repo is public and the digest holds
# senders and subjects. INBOUND_TRIAGE_DIR exists so selftest can use a tempdir.
def base_dir():
    return Path(os.environ.get("INBOUND_TRIAGE_DIR") or (Path.home() / "knowledge-os/logs/inbound-triage"))


# ---------------------------------------------------------------------------
# Pure helpers (covered by selftest)
# ---------------------------------------------------------------------------

def find_label(labels, prefix):
    """First label whose name starts "<prefix>: " or "<prefix>. " — the same
    prefix convention follow-up.html matches with /^8[.:]\\s/."""
    pat = re.compile(r"^%s[.:]\s" % re.escape(prefix))
    for l in labels:
        if pat.match(l.get("name", "")):
            return l
    return None


def parse_bare_email(from_header):
    """Bare address from a From header: '"Name" <a@b.com>' → 'a@b.com'.
    Airtable's Inbound Sender field is type email; the raw header would be
    rejected or stored as garbage."""
    m = re.search(r"<([^<>\s]+@[^<>\s]+)>", from_header or "")
    if m:
        return m.group(1)
    m = re.search(r"[^\s<>\"',;]+@[^\s<>\"',;]+", from_header or "")
    return m.group(0) if m else ""


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


def next_watermark(max_ms, unhandled_ms_list, truncated=False, old_ms=0):
    """Watermark rule. Advance to max_ms only when everything seen was handled
    AND the scan saw everything (not truncated). Any deferred or failed item
    pins the watermark just before the OLDEST of them. A truncated scan pins
    it where it was: Gmail lists newest-first, so the unseen messages are the
    OLDER ones, and advancing at all would lose them for good."""
    if truncated:
        return old_ms
    if not unhandled_ms_list:
        return max_ms
    return min(unhandled_ms_list) - 1


def trim_history(history, keep_days=30, today=None):
    d = today or date.today()
    cutoff = (d - timedelta(days=keep_days)).isoformat()
    return {k: v for k, v in history.items() if k >= cutoff}


# ---------------------------------------------------------------------------
# State, digest, scan cache
# ---------------------------------------------------------------------------

def read_state():
    p = base_dir() / "state.json"
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text())
    except (ValueError, OSError) as e:
        # ValueError covers JSONDecodeError AND UnicodeDecodeError. A corrupt
        # state file must be loud: silently restarting the watermark would
        # re-create a week of tasks (dedupe is the only guard left).
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


def write_scan_cache(messages):
    """id → {sender, subject, threadId, internalDate} for every message the
    scan returned, so act/note can log context without taking email text as
    arguments. Merged over the existing cache (multi-cycle runs)."""
    cache = read_scan_cache()
    for m in messages:
        cache[m["id"]] = {
            "sender": parse_bare_email((m.get("headers") or {}).get("from", "")),
            "subject": ((m.get("headers") or {}).get("subject", ""))[:200],
            "threadId": m.get("threadId", ""),
            "internalDate": m.get("internalDate"),
        }
    d = base_dir()
    d.mkdir(parents=True, exist_ok=True)
    (d / "scan-cache.json").write_text(json.dumps(cache))


def read_scan_cache():
    p = base_dir() / "scan-cache.json"
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text())
    except (ValueError, OSError):
        return {}


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
    key = read_secret(TRIAGE_KEY_FILE, "gmail triage key")
    req = urllib.request.Request(
        WORKER_URL + path,
        data=json.dumps(payload).encode(),
        headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as res:
            body = res.read().decode()
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")[:500]
        if e.code == 409:
            fail("Gmail not connected on the worker (409). Kevin grants once at "
                 "%s/auth/gmail — then retry. Detail: %s" % (WORKER_URL, detail))
        fail("worker %s answered %d: %s" % (path, e.code, detail))
    except (urllib.error.URLError, TimeoutError) as e:
        fail("worker %s unreachable: %s" % (path, e))
    try:
        return json.loads(body)
    except ValueError:
        fail("worker %s returned non-JSON (%s...)" % (path, body[:120]))


def worker_labels():
    return worker_post("/gmail/labels", {}).get("labels", [])


def worker_list(q=None, label_ids=None, max_pages=MAX_PAGES):
    """Follow nextPageToken up to max_pages. Returns (messages, truncated).
    truncated=True means Gmail had MORE matches than we fetched — the caller
    must not treat the listing as complete."""
    messages, token = [], None
    for _ in range(max_pages):
        payload = {}
        if q:
            payload["q"] = q
        if label_ids:
            payload["labelIds"] = label_ids
        if token:
            payload["pageToken"] = token
        data = worker_post("/gmail/list", payload)
        messages.extend(data.get("messages", []))
        token = data.get("nextPageToken")
        if not token:
            return messages, False
    return messages, True


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
    except (urllib.error.URLError, TimeoutError, ValueError) as e:
        fail("Airtable unreachable or unreadable writing Metric Score: %s" % e)


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

def resolve_triage_labels(labels=None):
    labels = labels if labels is not None else worker_labels()
    l8 = find_label(labels, "8")
    l12 = find_label(labels, "12")
    l13 = find_label(labels, "13")
    if not l8 or not l12:
        fail("triage labels missing: found 8=%s 12=%s — the lanes the whole "
             "routing depends on. Do not continue; report this."
             % (l8 and l8["name"], l12 and l12["name"]))
    return l8, l12, l13


def cmd_labels():
    labels = worker_labels()
    l8, l12, l13 = resolve_triage_labels(labels)
    print(json.dumps({
        "label8": l8, "label12": l12, "label13": l13,
        "all_user_labels": [{"id": l["id"], "name": l["name"]}
                            for l in labels if l.get("type") != "system"],
    }, indent=1))


def cmd_scan(back_hours):
    labels = worker_labels()
    l8, l12, l13 = resolve_triage_labels(labels)
    state = read_state()
    now_ms = int(datetime.now().timestamp() * 1000)
    first_run = "watermark_ms" not in state
    wm = state.get("watermark_ms", now_ms - 7 * 86400 * 1000)
    after_s = max(0, wm // 1000 - back_hours * 3600)

    new_inbox, new_trunc = worker_list(q="in:inbox -in:chats after:%d" % after_s)
    stale, stale_trunc = worker_list(q="in:inbox -in:chats older_than:2d")
    # Stranded lookups use exact label IDs — no query syntax to mis-parse.
    stranded_8, s8_trunc = worker_list(label_ids=[l8["id"]], q="newer_than:14d")
    stranded_12, s12_trunc = worker_list(label_ids=[l12["id"]], q="newer_than:14d")

    write_scan_cache(new_inbox + stale + stranded_8 + stranded_12)

    print(json.dumps({
        "watermark_ms": wm,
        "first_run": first_run,
        "now_ms": now_ms,
        "labels": {"label8": {"id": l8["id"], "name": l8["name"]},
                   "label12": {"id": l12["id"], "name": l12["name"]},
                   "label13": {"id": l13["id"], "name": l13["name"]} if l13 else None},
        "counts": {"new_inbox": len(new_inbox), "stale": len(stale),
                   "stranded_8": len(stranded_8), "stranded_12": len(stranded_12)},
        "truncated": {"new_inbox": new_trunc, "stale": stale_trunc,
                      "stranded_8": s8_trunc, "stranded_12": s12_trunc},
        "new_inbox": new_inbox,
        "stale": stale,
        "stranded_8": stranded_8,
        "stranded_12": stranded_12,
    }))


def cmd_act(msg_id, action, reason):
    ctx = read_scan_cache().get(msg_id, {})
    if action == "archive":
        add, remove = [], ["INBOX"]
    elif action in ("label12", "label13"):
        l8, l12, l13 = resolve_triage_labels()
        chosen = l12 if action == "label12" else l13
        if not chosen:
            fail("label for %s not found in Gmail" % action)
        # Gmail's "move to label": add the label, take it out of the inbox —
        # exactly what Kevin's manual move does.
        add, remove = [chosen["name"]], ["INBOX"]
    elif action == "label8":
        # Kevin's ruling, 24 Aug 2026: the triage agent routes nothing to
        # Mica's approval lane — the AI CEO handles her lane's work with Kevin
        # approving. Label 8 stays hers for manual use only.
        fail("label8 is not a triage destination (Kevin's ruling, 24 Aug 2026): "
             "actionable mail goes to label12")
    else:
        fail("unknown action %r" % action)
    result = worker_post("/gmail/modify", {"ids": [msg_id], "addLabels": add, "removeLabels": remove})
    digest_append({"id": msg_id, "do": action, "sender": ctx.get("sender", ""),
                   "subject": ctx.get("subject", ""), "reason": reason})
    print(json.dumps({"done": action, "id": msg_id, "modified": result.get("modified")}))


def cmd_note(msg_id, action, reason):
    if action not in ("leave", "task-created", "duplicate", "deferred"):
        fail("unknown note %r" % action)
    ctx = read_scan_cache().get(msg_id, {})
    digest_append({"id": msg_id, "do": action, "sender": ctx.get("sender", ""),
                   "subject": ctx.get("subject", ""), "reason": reason})
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

    labels = [{"id": "La", "name": "8: task created"}, {"id": "Lb", "name": "12: Kevin to respond"},
              {"id": "Lc", "name": "13: Maintenance"}, {"id": "Ld", "name": "128: decoy"}]
    check("find 8", find_label(labels, "8")["id"] == "La")
    check("find 12", find_label(labels, "12")["id"] == "Lb")
    check("find 13", find_label(labels, "13")["id"] == "Lc")
    check("no prefix over-match", find_label(labels, "1") is None)

    check("bare email from angle form", parse_bare_email('"Amy B" <amy@ex.com>') == "amy@ex.com")
    check("bare email from plain form", parse_bare_email("amy@ex.com") == "amy@ex.com")
    check("bare email from junk", parse_bare_email("no address here") == "")

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
    check("watermark frozen on truncation", next_watermark(1000, [], truncated=True, old_ms=50) == 50)
    check("truncation beats clean-handled", next_watermark(1000, [800], truncated=True, old_ms=50) == 50)

    trimmed = trim_history({"2020-01-01": 1, today.isoformat(): 0}, keep_days=30, today=today)
    check("history trims old days", "2020-01-01" not in trimmed and today.isoformat() in trimmed)

    with tempfile.TemporaryDirectory() as tmp:
        os.environ["INBOUND_TRIAGE_DIR"] = tmp
        try:
            write_state({"watermark_ms": 42})
            check("state roundtrip", read_state()["watermark_ms"] == 42)
            (Path(tmp) / "state.json").write_bytes(b"\xff\xfenot json")
            try:
                read_state()
                check("corrupt state fails loudly", False)
            except SystemExit:
                pass
            write_state({"watermark_ms": 42})
            write_scan_cache([{"id": "m1", "threadId": "t1", "internalDate": 5,
                               "headers": {"from": "Bob <bob@ex.com>", "subject": "Hi"}}])
            check("scan cache stores bare sender", read_scan_cache()["m1"]["sender"] == "bob@ex.com")
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
        cmd_act(msg_id, action, opt("--reason", ""))
    elif cmd == "note":
        msg_id = opt("--id")
        action = opt("--do")
        if not msg_id or not action:
            fail("note needs --id and --do")
        cmd_note(msg_id, action, opt("--reason", ""))
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
