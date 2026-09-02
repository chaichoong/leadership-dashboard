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
                                              [--override "why a human wrote it"]
                                              (label12/13 refuse a scan-flagged
                                              auto-reply without an override)
                                              apply one triage decision + log
                                              it (sender/subject come from the
                                              scan cache, never from argv)
  inbound-triage.py act --id MSGID --do file --label-num N [--reason R]
                                              file into an allow-listed
                                              taxonomy label (6, 10, 11, 17,
                                              18) and archive; no task
  inbound-triage.py note --id MSGID --do leave|task-created|duplicate|deferred [--reason R]
                                              log a no-Gmail-change decision
  inbound-triage.py mark --upto MS            advance the watermark (epoch ms)
  inbound-triage.py score --waiting N         record today's waiting count and
                                              write Metric Score to the register
  inbound-triage.py publish                   upsert today's decisions to the
                                              AI Agent Daily Log row on the
                                              register, so Kevin can check in
                                              from the agent's panel
  inbound-triage.py history-stale             exit 0 when the history book needs
                                              a rebuild (never built, or older
                                              than 7 days)
  inbound-triage.py history-build [--pages N] rebuild the Triage History Book in
                                              Airtable from end-state label
                                              membership — human filing only,
                                              the agent's own moves excluded
  inbound-triage.py history-dump              the history book as JSON, for the
                                              run's pre-read file
  inbound-triage.py matters                   every open agent task plus 14 days
                                              of completed ones, keyed for the
                                              matter-level dedupe
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
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta
from pathlib import Path

WORKER_URL = "https://drive-upload.kevinbrittain.workers.dev"

# The mailbox this agent triages: the business hub every address forwards into
# (it sends as the operationsdirector.co.uk addresses, carries the numbered
# 1-18 label taxonomy, and is the inbox Mica managed). Established on the
# first live run, 24 Aug 2026: kevinbrittain@gmail.com is a DIFFERENT mailbox
# (273 property-address labels, no taxonomy) and is out of triage scope.
TRIAGE_ACCOUNT = "kevin@runpreneur.org.uk"

TRIAGE_KEY_FILE = Path.home() / ".config/od/gmail_triage_key"
AIRTABLE_PAT_FILE = Path.home() / ".config/od/airtable_pat"

AIRTABLE_BASE = "appnqjDpqDniH3IRl"
AGENTS_TABLE = "tbl9msVjyQWslLOIZ"
TRIAGE_AGENT_ROW = "recYy33zkoa099uM2"   # "Inbound Comms Triage" in AI Agents
METRIC_SCORE_FIELD = "fldkGxrOlrfuLlH3J"  # singleLineText — current reading
AGENT_NAME = "Inbound Comms Triage"

# AI Agent Daily Log — one row per agent per day so Kevin can check the
# decisions from the agent's panel (Systemisation → AI Agents) or leave them.
# `publish` upserts today's row from the digest at the end of each run.
DAILY_LOG_TABLE = "tbl6VQKVMnK0Q7hbJ"
ALOG = {
    "logDay":    "fldNLubsilKUL6fyd",  # primary — "<Agent Name> - YYYY-MM-DD"
    "date":      "fldr9ktRlG8e93AMN",
    "agent":     "fld8OSVSzfXcDjDIl",  # link to AI Agents
    "summary":   "fld0vrdlfSiZjR6wg",
    "decisions": "fldTwM2eJvNyUibi4",
}

# Decision groups in display order, shared by publish. Plain English: Kevin
# reads this on the agent's panel.
DECISION_GROUPS = [
    ("label12",      "Moved to the agent lane (task for your approval)"),
    ("task-created", "Task record written"),
    ("label13",      "Moved to the maintenance lane"),
    ("file-6",       "Filed: newsletter"),
    ("file-10",      "Filed: property compliance"),
    ("file-11",      "Filed: tenancy documents"),
    ("file-17",      "Filed: OD prospects"),
    ("file-18",      "Filed: creditor"),
    ("archive",      "Archived as machine noise (reversible)"),
    ("updated",      "Existing thread task updated, no duplicate made"),
    ("answered",     "Already answered by us, no task needed"),
    ("leave",        "Left in the inbox on purpose"),
    ("deferred",     "Deferred to tomorrow (daily cap)"),
    ("duplicate",    "Already had a task, nothing created"),
]

# Airtable multilineText holds ~100k chars; stay well clear so an oversized
# day truncates predictably instead of failing the write.
DECISIONS_CHAR_CAP = 90000

# One list call returns at most 25 (the worker's subrequest budget); we follow
# nextPageToken up to this many pages per query, then report truncated=True.
MAX_PAGES = 4

# File-only lanes the agent may apply (label + archive, no task): 6 newsletter,
# 10 property compliance, 11 tenancy docs, 17 OD prospects, 18 creditor.
# NEVER in this set: 7 ("delete" — other flows may purge it), 9/14 (completion
# labels owned by the completion sweep), 1-5 (Kevin's manual workflow states),
# 15/16 (automation-owned), and the non-numbered pipeline labels ("Invoice to
# Airtable", "Send to Airtable", "Add to ... AT Board") which trigger flows.
FILE_LABEL_ALLOW = {"6", "10", "11", "17", "18"}

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
    arguments. Merged over the existing cache (multi-cycle runs), trimmed to
    30 days so it cannot accrete for ever."""
    cutoff_ms = int((datetime.now() - timedelta(days=30)).timestamp() * 1000)
    cache = {k: v for k, v in read_scan_cache().items()
             if (v.get("internalDate") or cutoff_ms) >= cutoff_ms}
    for m in messages:
        cache[m["id"]] = {
            "sender": parse_bare_email((m.get("headers") or {}).get("from", "")),
            "subject": ((m.get("headers") or {}).get("subject", ""))[:200],
            "threadId": m.get("threadId", ""),
            "internalDate": m.get("internalDate"),
            # read back by act (lane refusal) and by the task gate (thread
            # refusal) — the reason string, so the digest can say why
            "auto_reply": m.get("auto_reply") or None,
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
    # Every call names the triage mailbox explicitly — the worker's default
    # account is the SENDER default, which is a different mailbox entirely.
    payload = dict(payload)
    payload.setdefault("account", TRIAGE_ACCOUNT)
    req = urllib.request.Request(
        WORKER_URL + path,
        data=json.dumps(payload).encode(),
        # Cloudflare's browser integrity check bans the default Python-urllib
        # user agent with error 1010 (found on the first live run, 24 Aug
        # 2026); curl passes. Any honest non-default UA satisfies it.
        headers={"Authorization": "Bearer " + key, "Content-Type": "application/json",
                 "User-Agent": "od-inbound-triage/1.0"},
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


def airtable_request(method, path, payload=None, what="Airtable call"):
    pat = read_secret(AIRTABLE_PAT_FILE, "Airtable PAT")
    req = urllib.request.Request(
        "https://api.airtable.com/v0/%s/%s" % (AIRTABLE_BASE, path),
        data=json.dumps(payload).encode() if payload is not None else None,
        headers={"Authorization": "Bearer " + pat, "Content-Type": "application/json"},
        method=method,
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            return json.loads(res.read().decode())
    except urllib.error.HTTPError as e:
        fail("%s failed (%d): %s" % (what, e.code, e.read().decode(errors="replace")[:300]))
    except (urllib.error.URLError, TimeoutError, ValueError) as e:
        fail("%s unreachable or unreadable: %s" % (what, e))


def airtable_patch_metric(text):
    return airtable_request(
        "PATCH", "%s/%s" % (AGENTS_TABLE, TRIAGE_AGENT_ROW),
        {"fields": {METRIC_SCORE_FIELD: text}}, "register Metric Score write")


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
    # Lane 13 raises a Roy task since 25 Aug 2026, so a labelled-but-taskless
    # maintenance email is now exactly the kind of miss the stranded check
    # exists for. l13 missing from Gmail is survivable (empty list) but noted.
    stranded_13, s13_trunc = (worker_list(label_ids=[l13["id"]], q="newer_than:14d")
                              if l13 else ([], False))
    # SENT mail (Kevin's ruling, 25 Aug 2026): what WE sent must be measured
    # too, so a thread Kevin already answered never spawns a task and an open
    # task he answered himself gets closed. 3 days covers a weekend of manual
    # replies; the per-thread map keeps only the LATEST outgoing time.
    sent_msgs, sent_trunc = worker_list(q="in:sent newer_than:3d")
    sent_threads = {}
    for m in sent_msgs:
        tid = m.get("threadId")
        ts = int(m.get("internalDate") or 0)
        if tid and ts > sent_threads.get(tid, 0):
            sent_threads[tid] = ts

    # Stamp every message with the auto-reply signal (shared with the task
    # gate), then keep machine replies OUT of the stranded lists: a stranded
    # list exists only to mint tasks, and a machine receipt never gets one.
    signal_fn = _load_gate().auto_reply_signal
    for lst in (new_inbox, stale, stranded_8, stranded_12, stranded_13):
        annotate_auto_replies(lst, signal_fn)
    stranded_8, ar8 = split_auto_replies(stranded_8)
    stranded_12, ar12 = split_auto_replies(stranded_12)
    stranded_13, ar13 = split_auto_replies(stranded_13)
    stranded_auto_replies = ar8 + ar12 + ar13
    inbox_auto_replies = sum(1 for m in new_inbox if m.get("auto_reply"))

    write_scan_cache(new_inbox + stale + stranded_8 + stranded_12 + stranded_13
                     + stranded_auto_replies)

    # Record what this scan saw, so `mark` can ENFORCE the truncation freeze
    # rather than trusting the caller to apply it. Only new_inbox truncation
    # freezes the watermark: it is the only list the watermark governs.
    state["last_scan_truncated"] = bool(new_trunc)
    # A truncated FIRST run must also pin the backlog window: without a stored
    # watermark the 7-day default rolls forward daily, and a sustained backlog
    # would silently slide old mail out of the window. Storing the default
    # freezes the floor; only `mark` moves it after a full drain.
    if first_run:
        state["watermark_ms"] = wm
    write_state(state)

    print(json.dumps({
        "watermark_ms": wm,
        "first_run": first_run,
        "now_ms": now_ms,
        "labels": {"label8": {"id": l8["id"], "name": l8["name"]},
                   "label12": {"id": l12["id"], "name": l12["name"]},
                   "label13": {"id": l13["id"], "name": l13["name"]} if l13 else None},
        "counts": {"new_inbox": len(new_inbox), "stale": len(stale),
                   "stranded_8": len(stranded_8), "stranded_12": len(stranded_12),
                   "stranded_13": len(stranded_13), "sent": len(sent_msgs),
                   "inbox_auto_replies": inbox_auto_replies,
                   "stranded_auto_replies": len(stranded_auto_replies)},
        "truncated": {"new_inbox": new_trunc, "stale": stale_trunc,
                      "stranded_8": s8_trunc, "stranded_12": s12_trunc,
                      "stranded_13": s13_trunc, "sent": sent_trunc},
        "new_inbox": new_inbox,
        "stale": stale,
        "stranded_8": stranded_8,
        "stranded_12": stranded_12,
        "stranded_13": stranded_13,
        # Flagged lane mail, listed so the report can count it and the agent
        # can log the reference on the open matter — never a rescue.
        "stranded_auto_replies": [
            {"id": m.get("id"), "threadId": m.get("threadId"),
             "auto_reply": m.get("auto_reply"),
             "sender": parse_bare_email((m.get("headers") or {}).get("from", "")),
             "subject": ((m.get("headers") or {}).get("subject", ""))[:120],
             # enough to spot a wrong flag; the body test is a heuristic
             "excerpt": _load_gate().unquoted_body(m.get("body", ""))[:300]}
            for m in stranded_auto_replies],
        "sent_threads": sent_threads,
    }))


def cmd_act(msg_id, action, reason, label_num=None, override=None):
    ctx = read_scan_cache().get(msg_id, {})
    blocked = act_block_reason(ctx, action, override)
    if blocked:
        fail(blocked)
    if override and override.strip() and ctx.get("auto_reply"):
        reason = "OVERRIDE auto-reply flag (%s): %s — %s" % (
            ctx.get("auto_reply"), override.strip(), reason)
    digest_do = action
    if action == "archive":
        add, remove = [], ["INBOX"]
    elif action == "file":
        n = str(label_num or "")
        if n not in FILE_LABEL_ALLOW:
            fail("label %r is not a file destination. Allowed: %s. 7/9/14 and "
                 "the workflow/automation labels are never applied by triage."
                 % (n, sorted(FILE_LABEL_ALLOW)))
        lbl = find_label(worker_labels(), n)
        if not lbl:
            fail("no Gmail label with prefix %r found" % n)
        add, remove = [lbl["name"]], ["INBOX"]
        digest_do = "file-%s" % n
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
    digest_append({"id": msg_id, "do": digest_do, "sender": ctx.get("sender", ""),
                   "subject": ctx.get("subject", ""), "reason": reason})
    print(json.dumps({"done": digest_do, "id": msg_id, "modified": result.get("modified")}))


def cmd_note(msg_id, action, reason):
    if action not in ("leave", "task-created", "duplicate", "deferred",
                      "updated", "answered"):
        fail("unknown note %r" % action)
    ctx = read_scan_cache().get(msg_id, {})
    digest_append({"id": msg_id, "do": action, "sender": ctx.get("sender", ""),
                   "subject": ctx.get("subject", ""), "reason": reason})
    print(json.dumps({"noted": action, "id": msg_id}))


# ─── HAS THIS ALREADY BEEN DEALT WITH? (27 Aug 2026) ────────────────
#
# 24 of the 58 rejections Kevin had ever made — 41%, the single largest group —
# were "already dealt with elsewhere". He had replied himself, or Roy had, or
# another task had covered it, and the agent drafted a reply to a thread that
# was already answered. It could not have known: nothing in the pipeline ever
# looked at what had been SENT.
#
# The iMessage lane has had this since it was built (`imessage-sweep.py
# sentdump`). Gmail never did. This is the same check on the same shape: one
# listing of the sent folder, reduced to thread id -> the newest send.
#
# It is produced as a FILE by the runner before the agent starts, exactly like
# the iMessage dumps, because a check the agent has to remember to run is a
# check that gets skipped.
#
# THE CONTROL. An empty sent folder over a working week is not a quiet week, it
# is a broken query or a dead credential — and a broken query here reads as
# "nothing has been answered", which would send the agent to draft replies to
# every thread Kevin has already handled. So zero sends across the window FAILS
# rather than returning an empty map. See feedback_a_running_job_is_not_a_working_job.
SENTCHECK_MIN_DAYS_FOR_CONTROL = 3


def cmd_sentcheck(days):
    """thread id -> newest sent timestamp (ms), for the last `days` days."""
    days = max(1, int(days))
    messages, truncated = worker_list(q="in:sent newer_than:%dd" % days)
    threads = {}
    for m in messages:
        tid = m.get("threadId")
        if not tid:
            continue
        ts = int(m.get("internalDate") or 0)
        if ts > threads.get(tid, 0):
            threads[tid] = ts
    out = {
        "days": days,
        "sentMessages": len(messages),
        "threads": threads,
        # The agent MUST know when the listing was cut short: a truncated sent
        # folder means "not found here" no longer implies "not answered".
        "truncated": truncated,
    }
    if not messages and days >= SENTCHECK_MIN_DAYS_FOR_CONTROL:
        out["error"] = (
            "CONTROL FAILED: zero sent messages in %d days. Treat every thread "
            "as UNCHECKED, not as unanswered — this is a broken query or a dead "
            "credential, and drafting on it would reply to threads already "
            "handled." % days)
    print(json.dumps(out, indent=1))
    return 1 if out.get("error") else 0


def cmd_mark(upto_ms):
    state = read_state()
    # ENFORCED truncation freeze (not just an instruction): the last scan
    # having more inbox matches than it fetched means unseen OLDER mail exists,
    # and any forward move would lose it. Refuse; re-scan until the listing is
    # complete, then mark.
    if state.get("last_scan_truncated") and int(upto_ms) > state.get("watermark_ms", 0):
        fail("refusing to advance the watermark: the last scan was TRUNCATED, "
             "so unseen older mail exists. Re-run scan until truncated is "
             "false, then mark.")
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


def format_daily_log(rows):
    """(summary_line, decisions_text) from digest rows. Pure — selftested.
    Groups follow DECISION_GROUPS order; unknown decision kinds are appended
    rather than dropped, so a new action type can never vanish from the log."""
    by = {}
    for r in rows:
        by.setdefault(r.get("do", "?"), []).append(r)
    known = [k for k, _ in DECISION_GROUPS]
    ordered = list(DECISION_GROUPS) + [(k, k) for k in by if k not in known]
    counts, blocks = [], []
    for key, label in ordered:
        items = by.get(key, [])
        if not items:
            continue
        counts.append("%d %s" % (len(items), key))
        lines = ["== %s (%d) ==" % (label, len(items))]
        for r in items:
            t = (r.get("ts") or "")[11:16]
            lines.append("%s  %s | %s" % (t, r.get("sender") or "?", (r.get("subject") or "").strip()))
            if r.get("reason"):
                lines.append("       why: %s" % r["reason"])
        blocks.append("\n".join(lines))
    text = "\n\n".join(blocks)
    if len(text) > DECISIONS_CHAR_CAP:
        text = text[:DECISIONS_CHAR_CAP] + ("\n\n[truncated at %d characters; the complete raw log is on the Mac at ~/knowledge-os/logs/inbound-triage/]" % DECISIONS_CHAR_CAP)
    return ", ".join(counts), text


def cmd_publish():
    today = date.today().isoformat()
    src = base_dir() / ("digest-%s.jsonl" % today)
    if not src.exists():
        fail("no digest for today at %s — nothing ran, nothing to publish" % src)
    rows = [json.loads(l) for l in src.read_text().splitlines() if l.strip()]
    if not rows:
        fail("today's digest is empty — refusing to publish a blank day")
    summary, decisions = format_daily_log(rows)
    log_day = "%s - %s" % (AGENT_NAME, today)
    fields = {
        ALOG["logDay"]: log_day,
        ALOG["date"]: today,
        ALOG["agent"]: [TRIAGE_AGENT_ROW],
        ALOG["summary"]: summary,
        ALOG["decisions"]: decisions,
    }
    # Upsert on the primary key. A query ERROR must not fall through to a
    # create — that is the documented silent-zero duplicate trap.
    found = airtable_request(
        "GET",
        "%s?filterByFormula=%s&maxRecords=2" % (
            DAILY_LOG_TABLE,
            urllib.parse.quote("{Log Day}='%s'" % log_day.replace("'", "\\'"))),
        None, "daily log lookup")
    recs = found.get("records", [])
    if recs:
        result = airtable_request(
            "PATCH", "%s/%s" % (DAILY_LOG_TABLE, recs[0]["id"]),
            {"fields": fields, "typecast": True}, "daily log update")
        action = "updated"
    else:
        result = airtable_request(
            "POST", DAILY_LOG_TABLE,
            {"records": [{"fields": fields}], "typecast": True}, "daily log create")
        action = "created"
    print(json.dumps({"published": action, "log_day": log_day,
                      "decisions": len(rows), "summary": summary}))


# ---------------------------------------------------------------------------
# The history book + open matters (Kevin's approved chain map, 1 Sep 2026)
# ---------------------------------------------------------------------------
#
# Agent-gate EXTEND verdict on the register row (recYy33zkoa099uM2), 1 Sep
# 2026: two new pre-reads ground every run. THE HISTORY BOOK is where each
# sender's mail has historically been filed BY HUMANS — Kevin's and Mica's
# filing, never this agent's own, because a corpus containing the agent's own
# moves would teach it its own guesses (the don't-train-on-own-output rule).
# Gmail keeps no log of label MOVES, so end-state membership is the record:
# where an email sits today IS the accumulated filing decision. OPEN MATTERS
# is the estate-wide task snapshot, so a new message on a matter any agent
# already holds JOINS that task instead of becoming a sibling at the gate.

# Midnight 24 Aug 2026 Europe/London (BST, so 23:00 UTC on the 23rd) — the
# agent's first live run. Labelled mail received before this was filed by a
# human. The selftest derives this same number via zoneinfo, so a wrong
# hand-computed constant cannot survive.
AGENT_ERA_START_MS = 1787526000000

HISTORY_TABLE = "tblK1aGR7dYYYX2Bo"   # "Triage History Book"
HB = {
    "sender":    "fldbh3eMZ4C4l1G3n",  # primary — bare email address, lowercase
    "counts":    "fldRJHBqB1tKMeMZ0",  # JSON of RAW label-prefix counts ("6": 4)
    "dominant":  "fldLTwLk0V5ksY8X6",
    "total":     "fld085RNxSK6XpaT2",
    "humanEra":  "fldlD2ZHPMxrrwwYC",
    "handMoves": "fldfwOBqdtI6Yf7N5",
    "lastSeen":  "fldoVBjVL56AoiSZV",
    "lastBuilt": "fldA7wfceYI28zIwC",
}

# Which labels the book samples, and the triage OUTCOME each stands for. The
# completion labels 9 and 14 are evidence too: mail there passed through the
# actionable lanes before the completion sweep moved it, so both vote label12.
# Counts are STORED by raw label prefix — re-derivable if this mapping ever
# changes (the recon knowledge base's unrecoverable-key lesson); the mapping
# is applied only when a vote is computed, at dump time.
HISTORY_LANE_MAP = {
    "6": "file-6", "8": "label12", "9": "label12", "10": "file-10",
    "11": "file-11", "12": "label12", "13": "label13", "14": "label12",
    "17": "file-17", "18": "file-18",
}
HISTORY_STALE_DAYS = 7
HISTORY_BUILD_PAGES = 20      # per label; the worker returns 25 a page
HISTORY_MIN_SENDERS = 20      # control: the human era alone holds hundreds
HISTORY_MIN_TOTAL = 3         # a sender votes only with 3+ filings...
HISTORY_MIN_SHARE = 0.8       # ...and 80% agreement on one outcome

TEAM_TABLE = "tblco0p2OnlLQVAX7"
TM_NAME_FIELDS = ("fldFyTZu3vu1a7X3a", "fld1DYEbtyVsO2GVP")  # Preferred, Legal

# Task fields the matters snapshot reads — the same write-side ids the skill
# and create-agent-task.py use, so a rename cannot split read from write.
TASKS_TABLE = "tblqB8b22hKBL4PF1"
MT = {
    "name":     "fldgFjGBw6bTKJFCD",
    "status":   "fldx4qCw17UfrKpaN",
    "sender":   "fldzf4xlbrQuktx0i",
    "urls":     "fldXf1p0vtHqOZcKl",
    "team":     "flduCtmQGpOA4eWaj",
    "outcome":  "fldrHBSr6qoUfaKuZ",
    "priority": "fldS21RwmwOqt71LI",
}
MATTERS_CLOSED_DAYS = 14


def collect_agent_ids(digest_dir=None):
    """Message ids whose LABEL PLACEMENT this agent chose — every digest entry
    that MOVED mail (label12, label13, archive, file-*). Note-only entries
    (task-created, duplicate, updated, leave, answered, deferred) are kept
    OUT on purpose: stranded mail was labelled by a human before the agent
    ever tasked it, and that human filing is exactly the evidence the book
    exists to keep."""
    d = Path(digest_dir) if digest_dir else base_dir()
    ids = set()
    for p in sorted(d.glob("digest-*.jsonl")):
        for line in p.read_text().splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
            except ValueError:
                continue
            do = str(entry.get("do", ""))
            if do in ("archive", "label12", "label13") or do.startswith("file-"):
                if entry.get("id"):
                    ids.add(entry["id"])
    return ids


def classify_era(internal_ms, msg_id, agent_ids):
    """Who filed this labelled message? The agent check comes FIRST: the 24
    Aug 2026 backlog clear filed hundreds of PRE-era messages, so date alone
    would count the agent's own moves as human ground truth."""
    if msg_id in agent_ids:
        return "agent"
    if int(internal_ms or 0) < AGENT_ERA_START_MS:
        return "human-era"
    return "hand-move"


def map_counts(raw_counts):
    out = {}
    for prefix, n in (raw_counts or {}).items():
        lane = HISTORY_LANE_MAP.get(str(prefix))
        if lane:
            out[lane] = out.get(lane, 0) + int(n)
    return out


def history_vote(raw_counts):
    """The book's steer for a sender: a lane, or None when the evidence is
    thin (under HISTORY_MIN_TOTAL filings) or split (under HISTORY_MIN_SHARE
    agreement). None means 'no vote', never 'archive'."""
    lanes = map_counts(raw_counts)
    total = sum(lanes.values())
    if total < HISTORY_MIN_TOTAL:
        return None
    lane, top = max(lanes.items(), key=lambda kv: kv[1])
    return lane if top / total >= HISTORY_MIN_SHARE else None


def history_json(rows, now_iso):
    """The pre-read file from the Airtable rows. An empty book is a broken
    read or a never-run build — an ERROR object, never a quiet 'no history',
    because 'unknown sender' and 'no history exists' must stay distinguishable."""
    senders, built = {}, ""
    for r in rows:
        f = r.get("fields", {})
        addr = str(f.get(HB["sender"], "")).strip().lower()
        if not addr:
            continue
        try:
            raw = json.loads(f.get(HB["counts"]) or "{}")
        except ValueError:
            raw = {}
        senders[addr] = {
            "counts": raw,
            "total": int(f.get(HB["total"]) or 0),
            "vote": history_vote(raw),
            "humanEra": int(f.get(HB["humanEra"]) or 0),
            "handMoves": int(f.get(HB["handMoves"]) or 0),
        }
        built = max(built, str(f.get(HB["lastBuilt"]) or ""))
    if not senders:
        return {"error": "history book is EMPTY — treat every sender as "
                         "UNKNOWN; this is a broken read or a never-run "
                         "build, not an absence of history",
                "generated": now_iso}
    return {"generated": now_iso, "built": built,
            "senderCount": len(senders), "senders": senders}


def _status_name(v):
    return v.get("name", "") if isinstance(v, dict) else str(v or "")


def matters_json(open_rows, closed_rows, key_fn, team_names, now_iso):
    """The open-matters pre-read. Zero OPEN tasks is a broken read (the board
    always carries hundreds) — an error object, never an empty list, because
    'no open matter found' gates a create."""
    def item(r):
        f = r.get("fields", {})
        return {
            "id": r.get("id", ""),
            "name": f.get(MT["name"], ""),
            "key": key_fn(f.get(MT["name"], "")),
            "status": _status_name(f.get(MT["status"])),
            "outcome": _status_name(f.get(MT["outcome"])),
            "sender": str(f.get(MT["sender"]) or ""),
            "urls": str(f.get(MT["urls"]) or ""),
            "team": [team_names.get(t, t) for t in (f.get(MT["team"]) or [])],
        }
    if not open_rows:
        return {"error": "open-tasks read returned ZERO rows (expected "
                         "hundreds) — the matter check is UNCHECKED this "
                         "run; fall back to the per-thread dedupe and say so",
                "generated": now_iso}
    return {"generated": now_iso,
            "open": [item(r) for r in open_rows],
            "recentlyClosed": [item(r) for r in closed_rows],
            "counts": {"open": len(open_rows),
                       "recentlyClosed": len(closed_rows)}}


def _load_gate():
    """create-agent-task.py as a module — imported, never copied, so the
    matter key AND the auto-reply signal here can never drift from the
    gate's own."""
    import importlib.util
    p = Path(__file__).resolve().parent / "create-agent-task.py"
    spec = importlib.util.spec_from_file_location("od_catask", p)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _load_dupe_key():
    return _load_gate().dupe_task_key


# ─── AUTO-REPLIES (2 Sep 2026) ────────────────────────────────────────
#
# A council's automatic receipt of an email Kevin had already approved and
# sent reached his approval gate four times between 28 Aug and 1 Sep 2026.
# The route was the stranded-mail rescue: the thread carried label 12, its
# real task had COMPLETED, so "labelled with no open task" read as stranded
# and a fresh task was minted for a message that asks nothing. The signal
# (headers, subject family, receipt-shaped body) lives in the task gate;
# the scan stamps every message with it, keeps flagged mail OUT of the
# stranded lists, and `act` refuses to lane a flagged message unless the
# agent overrides with a reason that lands in the digest.

def annotate_auto_replies(messages, signal_fn):
    """Stamp each scanned message with auto_reply = reason or None."""
    for m in messages:
        h = m.get("headers") or {}
        m["auto_reply"] = signal_fn(h, h.get("subject", ""), m.get("body", ""))
    return messages


def split_auto_replies(messages):
    """(kept, dropped): stranded candidates minus the machine replies."""
    kept = [m for m in messages if not m.get("auto_reply")]
    dropped = [m for m in messages if m.get("auto_reply")]
    return kept, dropped


LANE_ACTIONS = ("label12", "label13", "label8")


def act_block_reason(ctx, action, override):
    """Why `act` must refuse, or None. Only the task lanes are guarded:
    archiving or filing a machine reply is exactly what should happen."""
    if action not in LANE_ACTIONS or not ctx.get("auto_reply"):
        return None
    if override and override.strip():
        return None
    return ("%s refused: the scan flagged this message as an auto-reply (%s). "
            "A machine receipt never gets a task — archive it, or file it in "
            "lane 18 if it is creditor mail, and log the reference on the open "
            "matter. If a human really wrote it, repeat with "
            "--override \"<why it is human>\" (the override is logged)."
            % (action, ctx.get("auto_reply")))


def _airtable_get_all(path_base, params):
    records, offset = [], None
    while True:
        qs = list(params)
        if offset:
            qs.append(("offset", offset))
        data = airtable_request(
            "GET", "%s?%s" % (path_base, urllib.parse.urlencode(qs)),
            None, "Airtable list %s" % path_base)
        records.extend(data.get("records", []))
        offset = data.get("offset")
        if not offset:
            return records


def cmd_history_stale():
    state = read_state()
    built = state.get("history_built_ms")
    now_ms = int(datetime.now().timestamp() * 1000)
    stale = built is None or (now_ms - built) > HISTORY_STALE_DAYS * 86400 * 1000
    print(json.dumps({"stale": stale, "built_ms": built}))
    return 0 if stale else 1


def cmd_history_build(pages):
    labels = worker_labels()
    agent_ids = collect_agent_ids()
    stats, sampled, truncated = {}, {}, {}
    excluded_agent = 0
    for prefix in sorted(HISTORY_LANE_MAP, key=int):
        lbl = find_label(labels, prefix)
        if not lbl:
            sampled[prefix] = None   # label absent in Gmail — noted, not fatal
            continue
        msgs, trunc = worker_list(label_ids=[lbl["id"]], max_pages=pages)
        truncated[prefix] = trunc
        kept = 0
        for m in msgs:
            addr = parse_bare_email((m.get("headers") or {}).get("from", ""))
            if not addr:
                continue
            era = classify_era(m.get("internalDate"), m.get("id"), agent_ids)
            if era == "agent":
                excluded_agent += 1
                continue
            s = stats.setdefault(addr.lower(),
                                 {"counts": {}, "human": 0, "hand": 0, "last_ms": 0})
            s["counts"][prefix] = s["counts"].get(prefix, 0) + 1
            s["human" if era == "human-era" else "hand"] += 1
            s["last_ms"] = max(s["last_ms"], int(m.get("internalDate") or 0))
            kept += 1
        sampled[prefix] = {"listed": len(msgs), "kept": kept}
    if len(stats) < HISTORY_MIN_SENDERS:
        fail("CONTROL FAILED: history build found %d senders (expected %d+). "
             "The human era alone holds hundreds of filed emails, so this is "
             "a broken listing or a mis-scoped account, not an empty history. "
             "Nothing was written." % (len(stats), HISTORY_MIN_SENDERS))
    now_iso = datetime.now().isoformat(timespec="seconds")
    records = []
    for addr, s in stats.items():
        records.append({"fields": {
            HB["sender"]: addr,
            HB["counts"]: json.dumps(s["counts"], sort_keys=True),
            HB["dominant"]: history_vote(s["counts"]) or "",
            HB["total"]: sum(s["counts"].values()),
            HB["humanEra"]: s["human"],
            HB["handMoves"]: s["hand"],
            HB["lastSeen"]: (datetime.fromtimestamp(s["last_ms"] / 1000)
                             .date().isoformat() if s["last_ms"] else ""),
            HB["lastBuilt"]: now_iso,
        }})
    for i in range(0, len(records), 10):
        airtable_request("PATCH", HISTORY_TABLE, {
            "performUpsert": {"fieldsToMergeOn": [HB["sender"]]},
            "records": records[i:i + 10],
            "typecast": True,
        }, "history book upsert")
    state = read_state()
    state["history_built_ms"] = int(datetime.now().timestamp() * 1000)
    write_state(state)
    # Counts only — runs.log must never carry sender addresses.
    print(json.dumps({"built": now_iso, "senders": len(stats),
                      "agentMovesExcluded": excluded_agent,
                      "sampled": sampled, "truncated": truncated}))


def cmd_history_dump():
    # returnFieldsByFieldId is load-bearing: history_json reads by field ID,
    # and without it Airtable keys the response by field NAME, every read
    # returns nothing, and the whole book presents as empty. The control
    # caught exactly this on the first live run, 1 Sep 2026.
    rows = _airtable_get_all(HISTORY_TABLE, [("pageSize", "100"),
                                             ("returnFieldsByFieldId", "true")])
    out = history_json(rows, datetime.now().isoformat(timespec="seconds"))
    print(json.dumps(out, indent=1))
    return 1 if out.get("error") else 0


def cmd_matters():
    key_fn = _load_dupe_key()
    formula = ("OR(AND({Status}!='Completed',{Status}!='Cancelled'),"
               "AND({Status}='Completed',"
               "IS_AFTER(LAST_MODIFIED_TIME(),DATEADD(TODAY(),-%d,'days'))))"
               % MATTERS_CLOSED_DAYS)
    params = [("pageSize", "100"), ("returnFieldsByFieldId", "true"),
              ("filterByFormula", formula)]
    for fid in MT.values():
        params.append(("fields[]", fid))
    rows = _airtable_get_all(TASKS_TABLE, params)
    team_names = {}
    tm_params = [("pageSize", "100"), ("returnFieldsByFieldId", "true")]
    tm_params += [("fields[]", f) for f in TM_NAME_FIELDS]
    for r in _airtable_get_all(TEAM_TABLE, tm_params):
        f = r.get("fields", {})
        nm = ""
        for fid in TM_NAME_FIELDS:
            v = f.get(fid)
            if isinstance(v, dict):
                v = v.get("name", "")
            if v:
                nm = str(v)
                break
        team_names[r["id"]] = nm or r["id"]
    open_rows = [r for r in rows
                 if _status_name(r.get("fields", {}).get(MT["status"]))
                 not in ("Completed", "Cancelled")]
    closed_rows = [r for r in rows
                   if _status_name(r.get("fields", {}).get(MT["status"]))
                   == "Completed"]
    out = matters_json(open_rows, closed_rows, key_fn, team_names,
                       datetime.now().isoformat(timespec="seconds"))
    print(json.dumps(out, indent=1))
    return 1 if out.get("error") else 0


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

    check("file allowlist excludes delete and completion labels",
          not ({"7", "9", "14"} & FILE_LABEL_ALLOW))

    summary, text = format_daily_log([
        {"ts": "2026-08-24T07:01:00", "do": "label12", "sender": "a@b.com", "subject": "Rent query", "reason": "needs a reply"},
        {"ts": "2026-08-24T07:02:00", "do": "archive", "sender": "n@l.com", "subject": "Sale now on", "reason": "marketing"},
        {"ts": "2026-08-24T07:03:00", "do": "someday-new-kind", "sender": "x@y.com", "subject": "Odd", "reason": "?"},
    ])
    check("daily log summary counts", "1 label12" in summary and "1 archive" in summary)
    check("daily log groups labelled", "Moved to the agent lane" in text and "Rent query" in text)
    check("daily log keeps unknown kinds", "someday-new-kind" in text)
    long_rows = [{"ts": "2026-08-24T07:00:00", "do": "archive", "sender": "s@x.com",
                  "subject": "y" * 200, "reason": "z" * 200} for _ in range(400)]
    _, big = format_daily_log(long_rows)
    check("daily log truncates predictably", len(big) < DECISIONS_CHAR_CAP + 200 and "truncated" in big)

    check("watermark advances clean", next_watermark(1000, []) == 1000)
    check("watermark pins to oldest unhandled", next_watermark(1000, [800, 400]) == 399)
    check("watermark frozen on truncation", next_watermark(1000, [], truncated=True, old_ms=50) == 50)
    check("truncation beats clean-handled", next_watermark(1000, [800], truncated=True, old_ms=50) == 50)

    trimmed = trim_history({"2020-01-01": 1, today.isoformat(): 0}, keep_days=30, today=today)
    check("history trims old days", "2020-01-01" not in trimmed and today.isoformat() in trimmed)

    # ── the history book + open matters (1 Sep 2026) ──
    from zoneinfo import ZoneInfo
    check("era start is midnight 24 Aug 2026 London",
          AGENT_ERA_START_MS == int(datetime(2026, 8, 24,
              tzinfo=ZoneInfo("Europe/London")).timestamp() * 1000))
    agent_ids = {"mAgent"}
    check("agent-acted PRE-era mail is still the agent's, never human ground truth",
          classify_era(AGENT_ERA_START_MS - 999, "mAgent", agent_ids) == "agent")
    check("pre-era untouched mail is human filing",
          classify_era(AGENT_ERA_START_MS - 1, "mOld", agent_ids) == "human-era")
    check("post-era untouched mail is a hand move",
          classify_era(AGENT_ERA_START_MS + 1, "mNew", agent_ids) == "hand-move")
    check("thin evidence gives no vote", history_vote({"6": 2}) is None)
    check("split evidence gives no vote", history_vote({"6": 2, "12": 1}) is None)
    check("strong file lane votes", history_vote({"6": 4, "12": 1}) == "file-6")
    check("labels 8 and 9 fold into the actionable vote",
          history_vote({"8": 2, "9": 1}) == "label12")
    check("unknown label prefixes never vote",
          history_vote({"7": 5, "15": 5}) is None)
    empty_book = history_json([], "t")
    check("empty book is an error, not an empty map", "error" in empty_book)
    book = history_json([{"fields": {
        HB["sender"]: "Amy@Ex.com", HB["counts"]: '{"6": 4}',
        HB["total"]: 4, HB["humanEra"]: 4, HB["handMoves"]: 0,
        HB["lastBuilt"]: "2026-09-01T09:00:00"}}], "t")
    check("book keys senders lowercase with a vote",
          book["senders"]["amy@ex.com"]["vote"] == "file-6"
          and book["built"] == "2026-09-01T09:00:00")
    no_matters = matters_json([], [], lambda n: n, {}, "t")
    check("zero open tasks is an error, not an empty matters list",
          "error" in no_matters)
    m = matters_json(
        [{"id": "recX", "fields": {
            MT["name"]: "INBOUND: Sefton licence fee",
            MT["status"]: "Today", MT["sender"]: "a@council.gov.uk",
            MT["urls"]: "https://mail.google.com/mail/u/0/#all/T1",
            MT["team"]: ["reciHUAEcEkbctnZ6"]}}],
        [{"id": "recY", "fields": {
            MT["name"]: "INBOUND: eBay refund", MT["status"]: "Completed",
            MT["outcome"]: "Approved as-is"}}],
        lambda n: "KEY:" + n, {"reciHUAEcEkbctnZ6": "AI CEO"}, "t")
    check("matters items carry key, team name and both populations",
          m["open"][0]["key"].startswith("KEY:")
          and m["open"][0]["team"] == ["AI CEO"]
          and m["counts"] == {"open": 1, "recentlyClosed": 1})

    with tempfile.TemporaryDirectory() as tmp:
        for name, rows_ in [
            ("digest-2026-08-24.jsonl", [
                {"id": "mMoved", "do": "label12"},
                {"id": "mFiled", "do": "file-6"},
                {"id": "mArch", "do": "archive"},
                {"id": "mNoted", "do": "task-created"},
                {"id": "mLeft", "do": "leave"},
            ]),
        ]:
            (Path(tmp) / name).write_text(
                "\n".join(json.dumps(r) for r in rows_) + "\nnot json\n")
        got = collect_agent_ids(tmp)
        check("digest ids: moves collected, notes and junk lines skipped",
              got == {"mMoved", "mFiled", "mArch"})

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
            # The truncation freeze is ENFORCED, not advisory: mark must refuse
            # to move forward while the last scan reported unseen older mail.
            write_state({"watermark_ms": 42, "last_scan_truncated": True})
            try:
                cmd_mark(100)
                check("mark refuses while truncated", False)
            except SystemExit:
                pass
            check("watermark unchanged after refusal", read_state()["watermark_ms"] == 42)
            write_state({"watermark_ms": 42, "last_scan_truncated": False})
            cmd_mark(100)
            check("mark advances when not truncated", read_state()["watermark_ms"] == 100)
        finally:
            del os.environ["INBOUND_TRIAGE_DIR"]

    # ── auto-replies never become tasks (2 Sep 2026) ──
    gate = _load_gate()
    msgs = [
        {"id": "a", "threadId": "1a047d45bad0d05a", "headers": {"subject": "Automatic reply: Liability Order",
                                                   "from": "lt@burnley.gov.uk"}, "body": "Your email has reached the team."},
        {"id": "b", "threadId": "1a0496b9df667238", "headers": {"subject": "RE: Council Tax Account 23242360",
                                                   "from": "l@fylde.gov.uk"},
         "body": "Thank you for contacting Fylde Borough Council.\n\nYour request has been logged with reference CSV-2026-1159."},
        {"id": "c", "threadId": "1a05bdd5ac5c463e", "headers": {"subject": "Boiler", "from": "t@x.com"},
         "body": "Hi Kevin, the boiler has failed again, can someone come?"},
    ]
    annotate_auto_replies(msgs, gate.auto_reply_signal)
    check("scan stamps the subject-family reply", str(msgs[0]["auto_reply"]).startswith("subject"))
    check("scan stamps the receipt-body reply", str(msgs[1]["auto_reply"]).startswith("body"))
    check("scan leaves the human alone", msgs[2]["auto_reply"] is None)
    kept, dropped = split_auto_replies(msgs)
    check("stranded lists drop only the machine replies",
          [m["id"] for m in kept] == ["c"] and [m["id"] for m in dropped] == ["a", "b"])
    flagged = {"auto_reply": "subject: Automatic reply"}
    check("act refuses label12 on a flagged message", act_block_reason(flagged, "label12", None))
    check("act refuses label13 on a flagged message", act_block_reason(flagged, "label13", "") is not None)
    check("act still archives a flagged message", act_block_reason(flagged, "archive", None) is None)
    check("act still files a flagged message", act_block_reason(flagged, "file", None) is None)
    check("an override with a reason lifts the refusal",
          act_block_reason(flagged, "label12", "a person wrote this") is None)
    check("unflagged mail is unaffected", act_block_reason({"auto_reply": None}, "label12", None) is None)
    with tempfile.TemporaryDirectory() as td:
        os.environ["INBOUND_TRIAGE_DIR"] = td
        try:
            write_scan_cache(msgs)
            cache = read_scan_cache()
            check("cache carries the auto-reply reason", cache["a"]["auto_reply"] == msgs[0]["auto_reply"]
                  and cache["c"]["auto_reply"] is None)
            check("the gate reads the SAME cache file the scan wrote",
                  gate.scan_cache_path() == str(base_dir() / "scan-cache.json"))
            check("the gate refuses a task on the flagged thread",
                  gate.auto_reply_refusal({gate.F["name"]: "INBOUND: RE: Council Tax Account 23242360",
                                           gate.F["inboundUrl"]: "https://mail.google.com/mail/u/0/#all/1a0496b9df667238"},
                                          gate.load_scan_cache()) is not None)
            check("the gate creates for the human thread",
                  gate.auto_reply_refusal({gate.F["name"]: "INBOUND: Boiler",
                                           gate.F["inboundUrl"]: "https://mail.google.com/mail/u/0/#all/1a05bdd5ac5c463e"},
                                          gate.load_scan_cache()) is None)
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
        cmd_act(msg_id, action, opt("--reason", ""), opt("--label-num"),
                opt("--override"))
    elif cmd == "note":
        msg_id = opt("--id")
        action = opt("--do")
        if not msg_id or not action:
            fail("note needs --id and --do")
        cmd_note(msg_id, action, opt("--reason", ""))
    elif cmd == "sentcheck":
        return cmd_sentcheck(opt("--days", "7"))
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
    elif cmd == "publish":
        cmd_publish()
    elif cmd == "history-stale":
        return cmd_history_stale()
    elif cmd == "history-build":
        cmd_history_build(int(opt("--pages", str(HISTORY_BUILD_PAGES))))
    elif cmd == "history-dump":
        return cmd_history_dump()
    elif cmd == "matters":
        return cmd_matters()
    elif cmd == "selftest":
        selftest()
    else:
        fail("unknown command %r" % cmd)


if __name__ == "__main__":
    # main() returns the exit code for commands whose callers branch on it
    # (history-stale gates the weekly rebuild; sentcheck's control failure).
    # Dropping the return value here silently turned every one into 0.
    sys.exit(main(sys.argv[1:]) or 0)
