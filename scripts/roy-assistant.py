#!/usr/bin/env python3
"""Roy's assistant: Roy forwards a message to info@ and the agents do the work.

WHY (Kevin, 24 Sep 2026)
Roy Lavin heads the property business and works by email, in
info@agilelets.co.uk. He had a Property Manager page since 9 Sep and had not
closed one task on it: a new screen is a new habit, and new habits are the
thing he finds slow. So the assistant lives where he already is. He forwards a
tenant's email or text (or just writes a question) to info@ itself, with one
line on top saying what he wants, and gets the result back in the same inbox.

HOW
  1. Roy FORWARDS the message FROM info@agilelets.co.uk TO info@agilelets.co.uk.
     No new address: a message info@ sends to itself sits in info@'s SENT
     folder, and mail from outside never carries the SENT label, so the folder
     itself proves someone signed in to info@ wrote it. That is the same trust
     the SMS bridge rests on (workers/sms-email-bridge/worker.js).
  2. `poll` reads that folder and makes ONE "ROY:" task per message for Inbox
     Response, stamped `ROY REQUEST` (agent-dispatch.py is_roy_request), then
     emails Roy "Got it". Open tasks already on the board from the same sender
     are marked ROY IS HANDLING THIS, and the queue holds them while his
     request is open, so Kevin never gets two cards for one tenant.
  3. roy-assistant-run.sh runs the agent on those tasks straight away instead
     of leaving them for the next 07:00 or slot run.
  4. The agent answers Roy (ROY ANSWER:) or logs work for him (ROY DONE:) with
     no card, because nobody outside sees either. EVERY email to a tenant,
     contractor or agent is a card in Kevin's one approval queue (Kevin,
     24 Sep 2026: one gate; Roy approves nothing).
  5. `tell` emails Roy what became of each request: the answer, "with Kevin",
     "sent", "not sent" or "closed". Every request ends with an email; silence
     is the failure this estate paid for on 28 Aug, when 47 tasks were handed
     to Roy and he was told about none of them.

Mail that is NOT a request, and why it is skipped:
  * our own notes (subject opens "Assistant:"), which are also info@ to info@;
  * a REPLY to a tenant-text email ("Re: [SMS] ..." carrying the bridge
    marker): the bridge texts that to the tenant, it is not for us;
  * anything addressed to someone other than info@ alone: that is Roy
    writing to the world, not to his assistant;
  * anything older than this assistant's first run (state `sinceMs`).
A forward from Roy's personal Gmail cannot be proved to be him, so it is not
worked; he gets one reply asking him to forward from info@ instead.

USAGE
  roy-assistant.py poll [--dry-run]          new requests -> tasks + "Got it"
  roy-assistant.py tell [--dry-run]          outcome notes to Roy
  roy-assistant.py waiting                   ids of open Roy requests no agent has worked
  roy-assistant.py pending QUEUE_JSON        those of them the queue would hand an agent now
  roy-assistant.py tenant-note TENANT --task ROYTASK   (text on STDIN)
                                             one dated line on a tenant's Notes,
                                             the only tenant write the agent has
  roy-assistant.py selftest                  offline checks, no network
"""

import argparse
import importlib.util
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from agent_email_format import PROPERTY_SENDER  # noqa: E402  the one home of sending identities

LONDON = ZoneInfo("Europe/London")

ROY_INBOX = PROPERTY_SENDER
SMS_FROM = "sms@operationsdirector.co.uk"
BASE_ID = "appnqjDpqDniH3IRl"
TASKS = "tblqB8b22hKBL4PF1"
TENANTS = "tblX4elTuu01gwBYh"
BUSINESS_FIELD = "fldLu1Y4GzyWcDoxr"       # Tasks -> Business (js/config.js:272)
REAL_ESTATE = "recoGcXRXCniyJsTz"          # Businesses -> Real Estate (js/config.js:161)
PAT_PATH = os.path.expanduser("~/.config/od/airtable_pat")
STATE_DIR = os.path.expanduser(os.environ.get("ROY_ASSISTANT_STATE_DIR")
                               or "~/knowledge-os/logs/roy-assistant")
STATE_FILE = os.path.join(STATE_DIR, "state.json")
LOOKBACK_DAYS = 2           # the poll re-reads two days; processed ids stop repeats
PROCESSED_KEEP_DAYS = 30
TELL_WINDOW_DAYS = 30       # a request older than this is never written about again
TOLD_MARK = "ROY TOLD"
INSTRUCTION_MAX = 1500
FORWARD_BODY_MAX = 6000


def _load(name, filename):
    spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, filename))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


_MODS = {}


def mod(key):
    """agent-dispatch.py (fields, tier 1, the Roy-request rule), send-email.py
    (the one send path) and inbound-triage.py (the Gmail transport), each
    loaded once. Imported, never copied: a second copy is how rules drift."""
    files = {"ad": "agent-dispatch.py", "se": "send-email.py", "tri": "inbound-triage.py"}
    if key not in _MODS:
        _MODS[key] = _load("roy_" + key, files[key])
    return _MODS[key]


# ─── PURE: what a message in info@'s Sent folder is ─────────────────────

EMAIL_RE = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")
NOTE_PREFIX = "Assistant:"          # send-email.py ROY_NOTE_PREFIX (drift-tested)
BRIDGE_MARK_RE = re.compile(r"(?:GHL Conversation:|SMS_BRIDGE_ID:)\s*([A-Za-z0-9_-]{6,})")
FORWARD_START_RE = re.compile(
    r"^\s*(?:-{3,}\s*Forwarded message\s*-{3,}|Begin forwarded message:|"
    r"-{3,}\s*Original Message\s*-{3,})\s*$", re.I | re.M)
FWD_HEADER_RE = re.compile(r"^\s*(From|Date|Sent|Subject|To|Cc)\s*:\s*(.*)$", re.I)
REF_RE = re.compile(r"\bRef:\s*(rec[A-Za-z0-9]{14})\b")
SUBJECT_PREFIX_RE = re.compile(r"^\s*(?:(?:re|fwd?|fw)\s*:\s*)+", re.I)


def addresses(value):
    return [a.lower() for a in EMAIL_RE.findall(str(value or ""))]


def classify(msg, since_ms):
    """(kind, why) for one message listed from info@'s Sent folder."""
    h = msg.get("headers") or {}
    sender = addresses(h.get("from"))
    rcpts = set(addresses(h.get("to")) + addresses(h.get("cc")))
    subject = str(h.get("subject") or "")
    body = str(msg.get("body") or "")
    if "SENT" not in (msg.get("labelIds") or []):
        return "not-sent", "not in info@'s Sent folder, so not provably from info@"
    if sender != [ROY_INBOX]:
        return "not-from-info", "sent as another address"
    if rcpts != {ROY_INBOX}:
        return "not-to-self", "addressed to someone other than info@ alone"
    if subject.strip().startswith(NOTE_PREFIX):
        return "ours", "one of the assistant's own notes"
    if re.match(r"^\s*re\s*:", subject, re.I) and BRIDGE_MARK_RE.search(body):
        return "sms-reply", "a reply to a tenant text: the SMS bridge texts it back"
    if int(msg.get("internalDate") or 0) < int(since_ms or 0):
        return "old", "sent before the assistant started"
    return "request", ""


def parse_request(msg):
    """Roy's words, the forwarded message (if any), the text conversation (if
    any) and a follow-up reference, from one request message."""
    h = msg.get("headers") or {}
    body = str(msg.get("body") or "").replace("\r\n", "\n")
    m = FORWARD_START_RE.search(body)
    instruction = (body[:m.start()] if m else body).strip()
    fwd = None
    if m:
        rest = body[m.end():].lstrip("\n").split("\n")
        heads, i = {}, 0
        while i < len(rest):
            line = rest[i]
            hm = FWD_HEADER_RE.match(line)
            if hm:
                heads[hm.group(1).lower()] = hm.group(2).strip()
                i += 1
                continue
            if not line.strip() and heads:
                i += 1
                break
            if not line.strip():
                i += 1
                continue
            break
        from_raw = heads.get("from", "")
        mails = addresses(from_raw)
        fwd = {"from": from_raw, "email": mails[0] if mails else "",
               "date": heads.get("date") or heads.get("sent", ""),
               "subject": heads.get("subject", ""),
               "body": "\n".join(rest[i:]).strip()}
    sms = None
    bm = BRIDGE_MARK_RE.search(body)
    if bm:
        phone = re.search(r"^\s*>?\s*Phone:\s*([+\d][\d ()+-]{6,})", body, re.M)
        contact = ""
        subj = (fwd or {}).get("subject") or str(h.get("subject") or "")
        cm = re.search(r"\[SMS\]\s*([^:]+):", subj)
        if cm:
            contact = cm.group(1).strip()
        sms = {"conversation": bm.group(1), "phone": phone.group(1).strip() if phone else "",
               "contact": contact}
    ref = REF_RE.search(body)
    first = next((ln.strip() for ln in instruction.split("\n") if ln.strip()), "")
    fsub = SUBJECT_PREFIX_RE.sub("", (fwd or {}).get("subject") or "").strip()
    own = SUBJECT_PREFIX_RE.sub("", str(h.get("subject") or "")).strip()
    summary = (first or fsub or own or "a request")[:70]
    return {"instruction": instruction[:INSTRUCTION_MAX], "forwarded": fwd, "sms": sms,
            "followUp": ref.group(1) if ref else "", "summary": summary,
            "subject": str(h.get("subject") or "")}


# What always comes to Kevin before anything goes out (Kevin, 24 Sep 2026).
# Every email is a card today anyway; this list makes the card SAY so, tells
# Roy so in his "Got it", and is what a future move to fewer cards can never
# loosen for these subjects.
KEVIN_TOPICS = (
    ("a notice", r"\bnotice to quit\b|\bsection\s*(?:8|13|21)\b|\bs\.?\s?21\b|\bpossession\b|\bevict"),
    ("a rent change", r"\brent\s+(?:increase|rise|review|change|reduction|up|down)\b|"
                      r"\b(?:increase|raise|reduce|lower)\s+(?:the\s+|their\s+|his\s+|her\s+)?rent\b"),
    ("a deposit", r"\bdeposits?\b"),
    ("arrears", r"\barrears?\b|\bbehind\s+(?:on|with)\s+(?:the\s+|their\s+|his\s+|her\s+)?rent\b"),
    ("money", r"\brefund|\bcompensat|\bdiscount\b|\bwe(?:'ll|\s+will)\s+pay\b|£\s?\d"),
    ("a legal matter", r"\bsolicitor|\bcourt\b|\btribunal\b|\blegal\b|\blawyer|\bombudsman\b|"
                       r"\bdisrepair\b|\bliab(?:le|ility)\b"),
)


def kevin_topics(text):
    return [label for label, pat in KEVIN_TOPICS if re.search(pat, text or "", re.I)]


def request_text(req):
    fwd = req.get("forwarded") or {}
    return "\n".join([req.get("instruction") or "", fwd.get("subject") or "",
                      fwd.get("body") or ""])


def task_fields(req, msg, AF, now, response_rec):
    """The Airtable fields (by id) for one Roy request."""
    stamp = now.astimezone(LONDON).strftime("%d %b %Y %H:%M")
    fwd = req.get("forwarded")
    sms = req.get("sms")
    topics = kevin_topics(request_text(req))
    lines = [f"Roy's request, sent from {ROY_INBOX} on {stamp}:",
             req["instruction"] or "(No instruction line. Ask Roy what he wants done with this.)"]
    if req.get("followUp"):
        lines += ["", f"This follows up Roy's earlier request {req['followUp']}. Read that task first."]
    if topics:
        lines += ["", "Touches " + ", ".join(topics) + ". Any reply to anyone goes to Kevin's "
                  "queue, and the plain summary opens: Needs your decision: " + ", ".join(topics) + "."]
    if sms:
        lines += ["", f"This is a TEXT from {sms['contact'] or 'a tenant'}"
                  + (f" ({sms['phone']})" if sms["phone"] else "")
                  + f". Reply by text: SMS_BRIDGE_ID:{sms['conversation']}"]
    if fwd:
        lines += ["", "Forwarded message:", f"From: {fwd['from']}", f"Date: {fwd['date']}",
                  f"Subject: {fwd['subject']}", "", fwd["body"][:FORWARD_BODY_MAX]]
    fields = {
        AF["name"]: ("ROY: " + req["summary"])[:100],
        AF["description"]: "\n".join(lines)[:20000],
        AF["notes"]: (f"[{stamp} — roy-assistant] ROY REQUEST from {ROY_INBOX} "
                      f"(Gmail message {msg.get('id')}, thread {msg.get('threadId')})."
                      + (f" ALWAYS KEVIN: {', '.join(topics)}." if topics else "")),
        AF["inboundContent"]: str(msg.get("body") or "")[:20000],
        AF["teamMember"]: [response_rec],
        BUSINESS_FIELD: [REAL_ESTATE],
        AF["status"]: "Today",
        AF["dueDate"]: now.astimezone(LONDON).strftime("%Y-%m-%d"),
    }
    email = (fwd or {}).get("email") or ""
    if email and email not in (ROY_INBOX, SMS_FROM):
        fields[AF["inboundSender"]] = email
    if sms:
        fields[AF["inboundSourceType"]] = "SMS"
    elif fwd:
        fields[AF["inboundSourceType"]] = "Email"
    return fields


# ─── PURE: what to tell Roy about a request, and when ───────────────────

CARRY_LINE_RE = re.compile(r"\n*\s*(?:-{3,}\s*\n)?\s*\**\s*Carrying this out will involve:.*\Z",
                           re.I | re.S)
TOLD_RE = re.compile(r"\] " + TOLD_MARK + r" \(([a-z-]+)\)")


def told_kinds(notes):
    return set(TOLD_RE.findall(str(notes or "")))


def strip_label(output, label_re):
    text = CARRY_LINE_RE.sub("", str(output or "")).strip()
    return label_re.sub("", text, count=1).strip()


def parse_email(output):
    try:
        return mod("se").parse_output(output, "roy-assistant")
    except SystemExit:
        return None


def next_note(task, tier1, AF, handled_mark):
    """(kind, label, body) Roy should get next about this request, or None.

    One note per stage, never twice (the TOLD stamps on the task). A tier-1
    request gets ONE fixed line and nothing from the task, ever."""
    f = task.get("fields", {}) or {}
    notes = str(f.get(AF["notes"]) or "")
    told = told_kinds(notes)
    status = (f.get(AF["status"]) or {}).get("name") if isinstance(f.get(AF["status"]), dict) \
        else (f.get(AF["status"]) or "")
    outcome = f.get(AF["approvalOutcome"])
    outcome = outcome.get("name") if isinstance(outcome, dict) else (outcome or "")
    output = str(f.get(AF["agentOutput"]) or "")
    if tier1:
        return None if "private" in told else ("private", "with Kevin", "")
    done = status in ("Completed", "Cancelled")
    if "— send-email] SENT:" in notes and "sent" not in told:
        mail = parse_email(output)
        if mail and [a.lower() for a in mail["to"]] == [ROY_INBOX]:
            quote = re.search(r"^(On .+wrote:|-{2,}\s*Original Message|From: .+|>)", mail["body"], re.M)
            text = mail["body"][:quote.start()].strip() if quote else mail["body"]
            return ("sent", "texted", "Texted back to the tenant:\n\n" + text)
        if mail:
            return ("sent", "sent", f"Sent from {ROY_INBOX} to {', '.join(mail['to'])}.\n\n"
                    f"Subject: {mail['subject']}\n\n{mail['body']}")
        return ("sent", "sent", "Sent. The words are on the task.")
    if outcome == "Rejected" and "not-sent" not in told and "sent" not in told:
        why = str(f.get(AF["approvalFeedback"]) or "").strip() or (
            (f.get(AF["verdictReason"]) or {}).get("name", "") if isinstance(f.get(AF["verdictReason"]), dict)
            else str(f.get(AF["verdictReason"]) or ""))
        return ("not-sent", "not sent", "Kevin said no, so nothing went out."
                + (f"\n\nHis note: {why}" if why else ""))
    if done and ({"answer", "sent", "not-sent", "closed"} & told):
        return None
    if done and (re.search(r"\((roy answer|roy work logged)\)", notes)
                 or "FILED, not queued" in notes):
        text = strip_label(output, re.compile(r"^\s*ROY (?:ANSWER|DONE):\s*", re.I))
        return ("answer", "done", text or "Done.")
    if done and outcome.startswith("Approved"):
        summary = str(f.get(AF["plainSummary"]) or "").strip()
        return ("answer", "done", "Kevin approved this and it has been done."
                + (f"\n\n{summary}" if summary else ""))
    if done:
        why = ""
        hm = re.findall(re.escape(handled_mark) + r" \([^)]*\): ([^\n]*)", notes)
        if hm:
            why = hm[-1].split(". Level A")[0]
        return ("closed", "closed", "Closed without anything going out."
                + (f"\n\nWhy: {why}" if why else ""))
    if status == "Approval" and "with-kevin" not in told:
        mail = parse_email(output)
        if mail:
            return ("with-kevin", "with Kevin", "Drafted, and waiting for Kevin's yes. Nothing "
                    f"has gone out yet.\n\nTo: {', '.join(mail['to'])}\nSubject: {mail['subject']}"
                    f"\n\n{mail['body']}\n\nYou will get another email when it goes.")
        summary = str(f.get(AF["plainSummary"]) or "").strip() or strip_label(output, re.compile(r"^$"))[:1200]
        return ("with-kevin", "with Kevin", "This needs Kevin's decision before anything happens."
                + (f"\n\n{summary}" if summary else ""))
    return None


def note_email(task_id, summary, label, body):
    subject = f"{NOTE_PREFIX} {label} - {summary}"[:150]
    text = f"Roy,\n\n{body.strip()}\n\nRef: {task_id}\nRoy's assistant"
    return subject, text


def got_it_body(req):
    topics = kevin_topics(request_text(req))
    lines = ["Got it. Working on:", "", req["instruction"][:600] or
             "(You did not add a line saying what you want, so the assistant will ask.)"]
    if topics:
        lines += ["", "This touches " + ", ".join(topics) + ", so Kevin decides any reply "
                  "before it goes out."]
    lines += ["", "You will get another email when it is done."]
    return "\n".join(lines)


def is_personal_forward(msg, roy_gmail):
    h = msg.get("headers") or {}
    return (addresses(h.get("from")) == [roy_gmail]
            and re.match(r"^\s*(?:fwd?|fw)\s*:", str(h.get("subject") or ""), re.I) is not None)


NUDGE_BODY = ("Roy,\n\nYou forwarded something to info@ from your own Gmail. The assistant "
              "only works on messages forwarded FROM info@agilelets.co.uk, because that is how "
              "it knows the request is really from you.\n\nPlease open info@, press Forward "
              "(not Reply) on the message, send it to info@agilelets.co.uk, and add one line "
              "on top saying what you want.\n\nNothing was done with this one.\n\nRoy's assistant")


def pending_ids(queue, AF_is_roy):
    """Roy requests the queue says are waiting for an agent (kind new)."""
    out = []
    for t in (queue.get("worklist") or []) + (queue.get("reserve") or []):
        if t.get("kind") == "new" and AF_is_roy(t.get("name"), t.get("notes")) \
                and t["id"] not in out:
            out.append(t["id"])
    return out


# ─── STATE ───────────────────────────────────────────────────────────────

def read_state():
    try:
        with open(STATE_FILE) as fh:
            return json.load(fh)
    except FileNotFoundError:
        return {}


def write_state(state):
    os.makedirs(STATE_DIR, exist_ok=True)
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(state, fh, indent=1)
    os.replace(tmp, STATE_FILE)


def trim(state, now_ms):
    cut = now_ms - PROCESSED_KEEP_DAYS * 86400 * 1000
    for key in ("processed", "nudged"):
        state[key] = {k: v for k, v in (state.get(key) or {}).items()
                      if int((v or {}).get("at", now_ms)) >= cut}


# ─── AIRTABLE ────────────────────────────────────────────────────────────

def airtable(method, path, payload=None, params=None):
    with open(PAT_PATH) as fh:
        pat = fh.read().strip()
    url = f"https://api.airtable.com/v0/{BASE_ID}/{path}"
    if params:
        url += "?" + urllib.parse.urlencode(params, doseq=True)
    req = urllib.request.Request(url, method=method,
                                 data=json.dumps(payload).encode() if payload is not None else None)
    req.add_header("Authorization", f"Bearer {pat}")
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"Airtable {method} {path.split('?')[0]} {e.code}: "
                           f"{e.read().decode()[:300]}") from None


def airtable_all(table, formula, fields=None):
    out, offset = [], None
    while True:
        params = {"filterByFormula": formula, "pageSize": "100", "returnFieldsByFieldId": "true"}
        if fields:
            params["fields[]"] = fields
        if offset:
            params["offset"] = offset
        page = airtable("GET", table, params=params)
        out += page.get("records", [])
        offset = page.get("offset")
        if not offset:
            return out


def formula_str(value):
    """A value safe inside a single-quoted Airtable formula string."""
    return str(value).replace("\\", "\\\\").replace("'", "\\'")


def now_utc():
    return datetime.now(timezone.utc)


def append_note(task_id, current, line):
    notes = (str(current or "").rstrip() + "\n\n" + line).strip()[-90000:]
    airtable("PATCH", f"{TASKS}/{task_id}",
             {"fields": {mod("ad").AF["notes"]: notes}})
    return notes


# ─── COMMANDS ────────────────────────────────────────────────────────────

def list_sent(since_s):
    tri = mod("tri")
    msgs, truncated = tri.worker_list(q=f"in:sent to:{ROY_INBOX} after:{since_s}",
                                      account=ROY_INBOX)
    return msgs, truncated


def list_personal_forwards(since_s, roy_gmail):
    tri = mod("tri")
    msgs, _ = tri.worker_list(q=f"in:inbox from:{roy_gmail} after:{since_s}", account=ROY_INBOX)
    return msgs


def related_open_tasks(req, AF):
    """Open tasks already on the board about the same sender or text thread."""
    sms = req.get("sms")
    email = ((req.get("forwarded") or {}).get("email") or "").lower()
    base = ("AND(NOT({Status}='Completed'), NOT({Status}='Cancelled'), "
            "NOT(LEFT({Task Name}, 4)='ROY:'), "
            "IS_AFTER(CREATED_TIME(), DATEADD(TODAY(), -14, 'days')), %s)")
    if sms and sms.get("conversation"):
        cond = ("OR(FIND('%s', {Inbound Message Content}), FIND('%s', {Description}))"
                % ((formula_str(sms["conversation"]),) * 2))
    elif email and email not in (ROY_INBOX, SMS_FROM) and EMAIL_RE.fullmatch(email):
        cond = "LOWER({Inbound Sender})='%s'" % formula_str(email)
    else:
        return []
    return airtable_all(TASKS, base % cond, fields=[AF["name"], AF["notes"]])


def cmd_poll(args):
    ad, se = mod("ad"), mod("se")
    AF = ad.AF
    state = read_state()
    now = now_utc()
    now_ms = int(now.timestamp() * 1000)
    if "sinceMs" not in state:
        # First run: only what Roy sends from now on is a request. The 17 Sep
        # SMS-bridge test and any other old self-addressed mail stay history.
        state["sinceMs"] = now_ms
        state.setdefault("processed", {})
        if not args.dry_run:
            write_state(state)
    since_ms = max(int(state["sinceMs"]), now_ms - LOOKBACK_DAYS * 86400 * 1000)
    since_s = since_ms // 1000 - 3600
    msgs, truncated = list_sent(since_s)
    if truncated:
        # 100+ self-addressed messages in two days is not Roy. Stop loudly
        # rather than work a list whose oldest part was never read.
        print(json.dumps({"error": "info@ Sent listing was truncated; nothing created"}))
        return 1
    processed = state.setdefault("processed", {})
    created, skipped, errors = [], [], []
    for msg in sorted(msgs, key=lambda m: int(m.get("internalDate") or 0)):
        mid = msg.get("id")
        if not mid or mid in processed:
            continue
        kind, why = classify(msg, state["sinceMs"])
        if kind != "request":
            skipped.append({"id": mid, "kind": kind})
            if kind in ("ours", "sms-reply", "old", "not-to-self") and not args.dry_run:
                processed[mid] = {"at": now_ms, "skip": kind}
            continue
        # Airtable is the record: a crash between create and the state write
        # must not make a second task on the next tick.
        found = airtable_all(TASKS, "FIND('%s', {Notes})" % formula_str(mid), fields=[AF["name"]])
        if found:
            processed[mid] = {"at": now_ms, "task": found[0]["id"]}
            continue
        req = parse_request(msg)
        fields = task_fields(req, msg, AF, now, ad.RESPONSE_REC_ID)
        if args.dry_run:
            created.append({"dryRun": True, "name": fields[AF["name"]]})
            continue
        try:
            rec = airtable("POST", TASKS, {"fields": fields, "typecast": False})
        except RuntimeError as e:
            errors.append(f"create failed for {mid}: {e}")
            continue
        tid = rec["id"]
        processed[mid] = {"at": now_ms, "task": tid}
        write_state(state)
        created.append(tid)
        stamp = now.astimezone(LONDON).strftime("%d %b %Y %H:%M")
        notes = fields[AF["notes"]]
        # Hold the twins: the triage copy of the same tenant email must not
        # become a second card while Roy's request is open.
        try:
            for t in related_open_tasks(req, AF):
                tf = t.get("fields", {}) or {}
                if f"{ad.ROY_HANDLING_MARK}: {tid}" in str(tf.get(AF["notes"]) or ""):
                    continue
                append_note(t["id"], tf.get(AF["notes"]),
                            f"[{stamp} — roy-assistant] {ad.ROY_HANDLING_MARK}: {tid}. Roy sent this to "
                            "his assistant; the queue holds this task while that request is open. "
                            f"If it is the same matter, close it: CLOSE PROPOSAL: already handled — see {tid}")
                notes = append_note(tid, notes, f"[{stamp} — roy-assistant] Related open task "
                                    f"{t['id']} \"{str(tf.get(AF['name']) or '')[:80]}\" is held "
                                    "while this request is open.")
        except RuntimeError as e:
            errors.append(f"related-task check failed for {tid}: {e}")
        tier1 = ad.tier_match(ad.TIER1_PATTERNS, fields[AF["name"]], fields[AF["description"]], "")
        try:
            if tier1:
                res = se.send_roy_note(tid, "private", "", "")
                kind_told = "private"
            else:
                subject, text = note_email(tid, req["summary"], "got it", got_it_body(req))
                res = se.send_roy_note(tid, "got-it", subject, text)
                kind_told = "got-it"
            append_note(tid, notes, f"[{stamp} — roy-assistant] {TOLD_MARK} ({kind_told}): "
                                    f"Gmail {res.get('messageId') or res.get('why')}")
        except (SystemExit, RuntimeError) as e:
            errors.append(f"Got it note failed for {tid}: {e}")
    # A forward from his own Gmail: tell him once how to send it instead.
    nudged = []
    roy_gmail = ad.ROY_EMAIL
    for msg in list_personal_forwards(since_s, roy_gmail):
        mid = msg.get("id")
        if (not mid or mid in (state.get("nudged") or {})
                or int(msg.get("internalDate") or 0) < int(state["sinceMs"])
                or not is_personal_forward(msg, roy_gmail)):
            continue
        if args.dry_run:
            nudged.append(mid)
            continue
        try:
            se.send_roy_note("nudge-" + mid, "nudge", f"{NOTE_PREFIX} please forward from info@",
                             NUDGE_BODY, to=roy_gmail)
            state.setdefault("nudged", {})[mid] = {"at": now_ms}
            nudged.append(mid)
        except SystemExit as e:
            errors.append(f"nudge failed for {mid}: {e}")
    if not args.dry_run:
        trim(state, now_ms)
        write_state(state)
    print(json.dumps({"created": created, "skipped": skipped, "nudged": nudged,
                      "errors": errors}))
    return 1 if errors else 0


def cmd_tell(args):
    ad, se = mod("ad"), mod("se")
    AF = ad.AF
    formula = ("AND(LEFT({Task Name}, 4)='ROY:', FIND('%s', {Notes}), "
               "IS_AFTER(CREATED_TIME(), DATEADD(TODAY(), -%d, 'days')))"
               % (formula_str(ad.ROY_REQUEST_MARK), TELL_WINDOW_DAYS))
    fields = [AF[k] for k in ("name", "description", "notes", "status", "approvalOutcome",
                              "approvalFeedback", "verdictReason", "agentOutput", "plainSummary")]
    tasks = airtable_all(TASKS, formula, fields=fields)
    told, errors = [], []
    for t in tasks:
        f = t.get("fields", {}) or {}
        name, notes = f.get(AF["name"]) or "", f.get(AF["notes"]) or ""
        if not ad.is_roy_request(name, notes):
            continue
        output = str(f.get(AF["agentOutput"]) or "")
        tier1 = bool(ad.tier_match(ad.TIER1_PATTERNS, name, f.get(AF["description"]) or "", notes)
                     or ad.TIER1_BANNER in output)
        step = next_note(t, tier1, AF, ad.HANDLED_MARK)
        if not step:
            continue
        kind, label, body = step
        summary = name[len("ROY:"):].strip()
        if args.dry_run:
            told.append({"task": t["id"], "kind": kind})
            continue
        try:
            if kind == "private":
                res = se.send_roy_note(t["id"], "private", "", "")
            else:
                subject, text = note_email(t["id"], summary, label, body)
                res = se.send_roy_note(t["id"], kind, subject, text)
            stamp = now_utc().astimezone(LONDON).strftime("%d %b %Y %H:%M")
            append_note(t["id"], notes, f"[{stamp} — roy-assistant] {TOLD_MARK} ({kind}): "
                                        f"Gmail {res.get('messageId') or res.get('why')}")
            told.append({"task": t["id"], "kind": kind})
        except (SystemExit, RuntimeError) as e:
            errors.append(f"{t['id']} {kind}: {e}")
    print(json.dumps({"checked": len(tasks), "told": told, "errors": errors}))
    return 1 if errors else 0


def cmd_waiting(args):
    """Roy requests on the board an agent has not worked yet: the cheap check
    that decides whether a tick starts the expensive half at all."""
    ad = mod("ad")
    AF = ad.AF
    formula = ("AND(LEFT({Task Name}, 4)='ROY:', FIND('%s', {Notes}), "
               "OR({Status}='Today', {Status}='Overdue'))" % formula_str(ad.ROY_REQUEST_MARK))
    rows = airtable_all(TASKS, formula, fields=[AF["name"], AF["notes"]])
    ids = [r["id"] for r in rows
           if ad.is_roy_request((r.get("fields") or {}).get(AF["name"]),
                                (r.get("fields") or {}).get(AF["notes"]))]
    print(" ".join(ids))
    return 0


def cmd_pending(args):
    with open(args.queue) as fh:
        queue = json.load(fh)
    print(" ".join(pending_ids(queue, mod("ad").is_roy_request)))
    return 0


def cmd_tenant_note(args):
    ad = mod("ad")
    AF = ad.AF
    text = sys.stdin.read().strip()
    if not text:
        sys.exit("REFUSED: empty note")
    if len(text) > 2000:
        sys.exit("REFUSED: a tenant note is at most 2,000 characters")
    task = airtable("GET", f"{TASKS}/{args.task}", params={"returnFieldsByFieldId": "true"})
    tf = task.get("fields", {}) or {}
    if not ad.is_roy_request(tf.get(AF["name"]), tf.get(AF["notes"])):
        sys.exit(f"REFUSED: {args.task} is not a request Roy sent through info@")
    status = tf.get(AF["status"])
    if (status.get("name") if isinstance(status, dict) else status) in ("Completed", "Cancelled"):
        sys.exit(f"REFUSED: {args.task} is closed")
    hit = ad.tier_match(ad.TIER1_PATTERNS, text)
    if hit:
        sys.exit(f"REFUSED: the note matches tier-1 ({hit!r}); it goes to Kevin, never on a tenant")
    if not re.fullmatch(r"rec[A-Za-z0-9]{14}", args.tenant or ""):
        sys.exit("REFUSED: not a record id")
    # A GET by record id ignores the table, so prove it is a TENANT by listing
    # the Tenants table for it.
    rows = airtable_all(TENANTS, "RECORD_ID()='%s'" % args.tenant, fields=[ad.TENANT_NOTES_FIELD])
    if len(rows) != 1:
        sys.exit(f"REFUSED: {args.tenant} is not in the Tenants table")
    stamp = now_utc().astimezone(LONDON).strftime("%d %b %Y %H:%M")
    line = f"[{stamp} {ad.ROY_TENANT_NOTE_TAG}{args.task}] {text}"
    current = str((rows[0].get("fields") or {}).get(ad.TENANT_NOTES_FIELD) or "").rstrip()
    airtable("PATCH", f"{TENANTS}/{args.tenant}",
             {"fields": {ad.TENANT_NOTES_FIELD: (current + "\n" + line).strip()}})
    print(json.dumps({"tenant": args.tenant, "noted": True, "task": args.task}))
    return 0


def cmd_selftest(args):
    cases = []
    base = {"labelIds": ["SENT", "INBOX"], "internalDate": "2000",
            "headers": {"from": "Agile Lets <info@agilelets.co.uk>", "to": "info@agilelets.co.uk",
                        "subject": "Fwd: boiler"}, "body": "Tell her Tuesday\n"}
    cases.append(("a self-forward is a request", classify(base, 1000)[0] == "request"))
    cases.append(("mail from outside is not", classify({**base, "labelIds": ["INBOX"]}, 1000)[0] != "request"))
    cases.append(("our own note is not", classify({**base, "headers": {**base["headers"], "subject": "Assistant: got it - x"}}, 1000)[0] == "ours"))
    cases.append(("a text reply is the bridge's", classify({**base, "headers": {**base["headers"], "subject": "Re: [SMS] Stacey: hi"}, "body": "ok\n> SMS_BRIDGE_ID:abc123"}, 1000)[0] == "sms-reply"))
    cases.append(("Roy writing to a tenant is not", classify({**base, "headers": {**base["headers"], "to": "t@x.com"}}, 1000)[0] == "not-to-self"))
    cases.append(("before the start is not", classify(base, 5000)[0] == "old"))
    fwd = {**base, "body": "Tell her the plumber comes Tuesday\n\n---------- Forwarded message ---------\nFrom: Stacey Cole <stacey@example.com>\nDate: Wed, 24 Sept 2026\nSubject: Boiler\nTo: <info@agilelets.co.uk>\n\nThe boiler is leaking."}
    r = parse_request(fwd)
    cases.append(("instruction read", r["instruction"] == "Tell her the plumber comes Tuesday"))
    cases.append(("forwarded sender read", r["forwarded"]["email"] == "stacey@example.com"))
    cases.append(("forwarded body read", r["forwarded"]["body"] == "The boiler is leaking."))
    cases.append(("deposit is Kevin's", "a deposit" in kevin_topics("Can she have her deposit back?")))
    cases.append(("a boiler is not", kevin_topics("The boiler is leaking") == []))
    failed = [n for n, ok in cases if not ok]
    for n, ok in cases:
        print(("PASS " if ok else "FAIL ") + n)
    if failed:
        sys.exit("selftest FAILED: " + ", ".join(failed))
    print(f"selftest OK ({len(cases)} checks)")
    return 0


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("poll")
    s.add_argument("--dry-run", action="store_true")
    s.set_defaults(func=cmd_poll)
    t = sub.add_parser("tell")
    t.add_argument("--dry-run", action="store_true")
    t.set_defaults(func=cmd_tell)
    w = sub.add_parser("waiting")
    w.set_defaults(func=cmd_waiting)
    q = sub.add_parser("pending")
    q.add_argument("queue")
    q.set_defaults(func=cmd_pending)
    n = sub.add_parser("tenant-note")
    n.add_argument("tenant")
    n.add_argument("--task", required=True)
    n.set_defaults(func=cmd_tenant_note)
    st = sub.add_parser("selftest")
    st.set_defaults(func=cmd_selftest)
    args = p.parse_args()
    sys.exit(args.func(args))


if __name__ == "__main__":
    main()
