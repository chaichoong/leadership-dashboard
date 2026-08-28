#!/usr/bin/env python3
"""create-agent-task.py — THE create-time duplicate gate for agent-raised tasks.

Kevin's rule (25 Aug 2026): one subject = one open task. Chasers, follow-ups
and new developments on a matter are folded into the existing task, never
raised as siblings. The AI Agents page DETECTS leaks after the fact (the
Duplicates lane, keyed by dupeTaskKey in os/agents/index.html); this script
is the PREVENTION half, sitting in front of every scripted task create.

Every skill that creates agent tasks (inbound-email-triage Step 4/4b,
inbound-messages-sweep Step 5) calls this instead of a bare curl POST:

    python3 scripts/create-agent-task.py create --fields-json '<json keyed by
        Airtable field ID, exactly the payload the skill already specifies>'

Behaviour:
  * No open task shares the subject  -> POST creates it (unchanged payload).
  * An open task shares the subject AND the sender agrees -> PATCH folds the
    new item into that task (description appended, status/due/priority
    refreshed, an audit comment left) and NOTHING is created.
  * The subject matches but the sender differs -> CREATE anyway. Folding two
    different counterparties' matters into one task is worse than a
    duplicate: a tier-1 creditor letter must never land inside another
    creditor's thread. The page's Duplicates lane flags the pair for Kevin.

The subject key is dupe_task_key(), a line-for-line port of dupeTaskKey in
os/agents/index.html; tests/agents-dupe-task-key.test.js runs BOTH on the
same corpus and fails if they ever disagree, so the detector and this
preventer can never classify the same title differently.

CONTROL (the silent-zero trap, CLAUDE.md Airtable conventions): the gate
reads the open board, which always carries hundreds of tasks. Zero rows
means the read broke, not an empty business, and a broken existence check
that gates a create is exactly how duplicates get minted. On zero rows or
any API error the script EXITS NON-ZERO and creates nothing; the calling
skill counts the item unhandled and reports the failure.

Exit codes: 0 created/updated (JSON on stdout), 2 gate could not run
(broken read), 1 anything else.
"""

import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import date

BASE_ID = "appnqjDpqDniH3IRl"
TASKS = "tblqB8b22hKBL4PF1"

# Write-side field IDs, matching the triage create spec (the same map
# agent-dispatch.py's REVIEW_TASK_FIELDS mirrors).
F = {
    "name":         "fldgFjGBw6bTKJFCD",
    "status":       "fldx4qCw17UfrKpaN",
    "due":          "fld7XP8w8kbxfETV4",
    "hardDeadline": "fldZKzIxgyrQ8CG8a",
    "team":         "flduCtmQGpOA4eWaj",
    "priority":     "fldS21RwmwOqt71LI",
    "desc":         "fldRGhBQViKZKtkQ6",
    "inboundSender": "fldzf4xlbrQuktx0i",
    "inboundUrl":   "fldXf1p0vtHqOZcKl",
}

PRIORITY_RANK = {"Low": 0, "Medium": 1, "High": 2, "Urgent": 3}

# Personal-mailbox providers: a shared domain proves nothing about identity,
# so only an EXACT address match folds. A private (corporate) domain match
# is enough — creditors rotate individual senders behind one domain.
PUBLIC_MAIL_DOMAINS = {
    "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "hotmail.co.uk",
    "live.com", "live.co.uk", "yahoo.com", "yahoo.co.uk", "icloud.com",
    "me.com", "mac.com", "aol.com", "btinternet.com", "sky.com", "proton.me",
    "protonmail.com",
}

# Statuses that mean the task is finished with; everything else is "open".
CLOSED_STATUSES = {"Completed", "Cancelled"}


# Words that describe ANY incident and so cannot identify one. Shared
# verbatim with DUPE_GENERIC in os/agents/index.html.
DUPE_GENERIC = {
    "a",
    "an",
    "and",
    "are",
    "as",
    "at",
    "be",
    "been",
    "by",
    "for",
    "from",
    "in",
    "is",
    "it",
    "its",
    "of",
    "on",
    "or",
    "re",
    "that",
    "the",
    "this",
    "to",
    "was",
    "were",
    "with",
    "action",
    "again",
    "asap",
    "check",
    "consider",
    "deal",
    "fix",
    "handle",
    "investigate",
    "look",
    "needs",
    "please",
    "repeatedly",
    "resolve",
    "review",
    "sort",
    "urgent",
    "broken",
    "error",
    "errors",
    "exceed",
    "exceeded",
    "exceeding",
    "fail",
    "failed",
    "failing",
    "failure",
    "failures",
    "issue",
    "issues",
    "problem",
    "problems",
    "api",
    "app",
    "apps",
    "google",
    "script",
    "scripts",
    "service",
    "services",
    "ref",
    "reference",
    "usage",
}


def dupe_task_key(name):
    """THE INCIDENT ANCHOR. Line-for-line port of dupeTaskKey in
    os/agents/index.html; drift-tested in tests/agents-dupe-task-key.test.js.

    Rewritten 27 Aug 2026. The old key was "every significant word, in order",
    which caught a task differing only by a reference number and nothing else.
    Measured against the live queue that day it caught ZERO of the real
    duplicates: ten open tasks covering three incidents read as ten distinct
    subjects, because an AI writes the same incident up in fresh words each
    time. The Duplicates lane reported clean while the approvals gate held the
    duplicates.

    Two parts. THE LANE: a leading "INBOUND:" / "MAINTENANCE:" prefix is split
    off and kept, because a maintenance task and an inbound reply task about
    one thread are deliberately separate. Left in the words it ate one of the
    two subject slots and merged "Meetings Intake" with "Meetings to Supabase".
    THE SUBJECT: drop reference-like tokens, drop the generic vocabulary, keep
    the first two survivors, sort them. Falls back to the old full key when
    nothing distinctive survives, since an empty key would collide everything.
    """
    raw = str(name or "")
    lane = ""
    m = re.match(r"^([A-Za-z][A-Za-z ]*(?:\([^)]*\))?)\s*:\s*", raw)
    if m:
        lane = re.sub(r"[^a-z0-9]+", " ", m.group(1).lower()).strip()
        raw = raw[m.end():]
    s = re.sub(r"[^a-z0-9\s]", " ", raw.lower())
    words = [
        w for w in re.split(r"\s+", s)
        if w
        and not re.fullmatch(r"\d+", w)
        and not re.fullmatch(r"(?=(?:[^\d]*\d){3,})[a-z\d]+", w)
    ]
    distinctive = [w for w in words if w not in DUPE_GENERIC]
    # AN ADDRESS SAYS WHERE, NOT WHICH (28 Aug 2026). Two slots is not many,
    # and when the address leads the title it takes both: "18 Siddows Avenue —
    # garden complaint" and "18 Siddows Avenue — rent arrears" both keyed to
    # `avenue siddows` and folded into one another. Kevin has ~27 properties
    # with many open tasks each, so this was live. Place words now go to the
    # BACK of the queue for a slot rather than being dropped, because a task
    # whose whole subject is an address still needs a key.
    places = _place_tokens(words)
    ranked = [w for w in distinctive if w not in places] + \
             [w for w in distinctive if w in places]
    subject = " ".join(sorted(ranked[:2])) if ranked else " ".join(words).strip()
    return (lane + "|" + subject) if lane else subject


# ─── THE SECOND PASS: SAME MATTER, DIFFERENT WORDS (28 Aug 2026) ────
#
# Kevin, working the queue that morning: "there's still a lot where I seem to
# see some duplication, something referencing the same issue but with slightly
# different information."
#
# He was right. Measured against the 55 tasks waiting: the key above grouped
# them into 43 cards and missed SEVEN real pairs, every one of them the same
# matter written two different ways —
#
#   "Sefton Council HMO licence fee 150 unpaid 23 Viola St Bootle"
#   "pay Sefton landlord licence fee 150 GBP for 23 Viola Street Bootle"
#
#   "SMS reply from +447538631747"          (INBOUND lane)
#   "SMS from 447538631747 - maintenance"   (MAINTENANCE lane)
#
# Three reasons the key alone could not catch them:
#
#   1. IT KEEPS ONLY THE FIRST TWO DISTINCTIVE WORDS, SORTED. "Sefton Council"
#      and "pay Sefton" therefore differ, because `council` and `pay` both
#      survive as distinctive and only two slots exist.
#   2. IT DELETES EVERY NUMBER. A phone number or a house number is the
#      STRONGEST identity signal there is — two tasks quoting 447538631747 are
#      the same thread, whatever words surround them — and the key strips them
#      as reference noise.
#   3. IT SPLITS ON THE LANE PREFIX. Deliberate, and right for FOLDING (a
#      maintenance job and a reply about one thread are separate pieces of
#      work). Wrong for SHOWING him, which is what he was asking about.
#
# So this does not replace the key. The key is a fast exact bucket and keeps
# every catch it already has; this is a second pass over what it missed. A
# match is either.
#
# STRICTNESS IS A PARAMETER, because the two callers do different things:
#   fold  — destructive, one task absorbs another. Same lane required.
#   group — display only, in the approvals queue. Lane ignored, because a
#           thread appearing in two lanes is exactly the duplication he sees.

# Words that say what to DO about a matter rather than WHICH matter it is.
# "pay Sefton" and "Sefton Council" are one thing; the verb is not identity.
# Extends DUPE_GENERIC rather than replacing it — kept separate so the key's
# own behaviour, and its tests, are untouched.
DUPE_ACTION_WORDS = {
    "respond", "reply", "replies", "replying", "required", "require",
    "requires", "send", "sending", "sent", "provide", "pay", "paid", "paying",
    "call", "calling", "chase", "chasing", "contact", "unpaid", "outstanding",
    "overdue", "further", "recovery", "notice", "notification", "update",
    "updates", "incoming", "new", "important", "info", "information",
}

# A UK phone number in any of the shapes these tasks carry: +447538631747,
# 447538631747, 07538631747. The last nine digits are the same in all three,
# which is what makes them comparable.
DUPE_PHONE_RE = re.compile(r"\b(?:\+?44|0)?(\d{9,12})\b")

DUPE_MIN_SHARED = 2      # one shared word is a coincidence ("emails")
DUPE_MIN_RATIO = 0.5     # of the SHORTER task's distinctive words

# ─── AN ADDRESS SAYS WHERE, NOT WHICH ────────────────────────────────
#
# Caught by this file's own test before it shipped. "Gas safety certificate due
# 23 Viola Street Bootle" folded into "action overdue licensing tasks 23 Viola
# Street Bootle - EICR and Gas" on four shared words — three of which were the
# ADDRESS.
#
# That direction is genuinely dangerous here. Kevin has around 27 properties
# with many open tasks each, so counting address words as evidence would
# eventually fold a garden complaint into a rent arrears chase at the same
# house. The place is context; the matter is what differs.
#
# So place tokens still SHOW in the explanation (they are why a human recognises
# the pair) but never count toward the shared-word threshold.
DUPE_STREET_TYPES = {
    "street", "st", "road", "rd", "avenue", "ave", "lane", "close", "drive",
    "way", "court", "place", "crescent", "grove", "terrace", "gardens",
    "square", "walk", "hill", "park", "row", "view", "rise", "mews",
}


def _place_tokens(words):
    """Tokens naming WHERE: the street type, the name before it, the town
    after it. `23 Viola Street Bootle` -> viola, street, bootle."""
    place = set()
    for i, w in enumerate(words):
        if w not in DUPE_STREET_TYPES:
            continue
        place.add(w)
        if i:
            place.add(words[i - 1])
        if i + 1 < len(words):
            place.add(words[i + 1])
    return place


def dupe_signals(name):
    """(lane, strong_ids, distinctive_words) — what identifies this matter.

    Mirrored verbatim by dupeSignals in os/agents/index.html; drift-tested in
    tests/agents-dupe-task-key.test.js.
    """
    raw = str(name or "")
    lane = ""
    m = re.match(r"^([A-Za-z][A-Za-z ]*(?:\([^)]*\))?)\s*:\s*", raw)
    if m:
        lane = re.sub(r"[^a-z0-9]+", " ", m.group(1).lower()).strip()
        raw = raw[m.end():]
    strong = set()
    for digits in DUPE_PHONE_RE.findall(raw):
        strong.add("tel:" + digits[-9:])
    for digits in re.findall(r"\b\d{4,}\b", raw):
        # A phone number already claimed above must not also register as a
        # plain reference, or one number would count as two agreements.
        if "tel:" + digits[-9:] not in strong:
            strong.add("num:" + digits)
    cleaned = re.sub(r"[^a-z0-9\s]", " ", raw.lower())
    words = [
        w for w in cleaned.split()
        if w
        and not re.fullmatch(r"\d+", w)
        and not re.fullmatch(r"(?=(?:[^\d]*\d){3,})[a-z\d]+", w)
        and w not in DUPE_GENERIC
        and w not in DUPE_ACTION_WORDS
    ]
    # Kept as an ordered list too: a place is recognised by adjacency, and a
    # set has thrown that away.
    return lane, strong, set(words), _place_tokens(words)


def dupe_verdict(name_a, name_b, mode="group"):
    """Are these the same matter? Returns {match, why, shared}.

    `why` is written for KEVIN, not for a log: it is shown on the group header
    so he can confirm the call himself rather than trusting it. That is what he
    asked for — "a little bit better confirmation of that".
    """
    lane_a, strong_a, words_a, place_a = dupe_signals(name_a)
    lane_b, strong_b, words_b, place_b = dupe_signals(name_b)

    # THE LANE CHECK COMES FIRST IN FOLD MODE, ahead of even a shared phone
    # number. Folding is destructive — one task absorbs the other — and a
    # maintenance job absorbed into a reply task is a real obligation lost.
    # "SMS reply from +447538631747" and "SMS from 447538631747 - maintenance
    # reply" ARE one thread, and Kevin should SEE them together; that does not
    # mean one may quietly eat the other. Grouping shows, folding destroys, and
    # only the second needs to be careful.
    if mode == "fold" and lane_a != lane_b:
        return {"match": False, "why": "", "shared": []}

    both = sorted(strong_a & strong_b)
    if both:
        label = ", ".join(
            ("phone " + x[4:]) if x.startswith("tel:") else ("reference " + x[4:])
            for x in both)
        return {"match": True, "why": "same " + label, "shared": both}

    if not words_a or not words_b:
        return {"match": False, "why": "", "shared": []}
    shared = sorted(words_a & words_b)
    # The threshold is judged on what is left once the address is set aside.
    places = place_a | place_b
    telling = [w for w in shared if w not in places]
    if len(telling) < DUPE_MIN_SHARED:
        return {"match": False, "why": "", "shared": shared}
    ratio = len(shared) / min(len(words_a), len(words_b))
    if ratio < DUPE_MIN_RATIO:
        # Enough words in common to look related, not enough to be the same
        # matter: "Sefton licence fee" and "Viola Street EICR and Gas" share a
        # property and nothing else.
        return {"match": False, "why": "", "shared": shared}
    return {"match": True, "why": "both about " + ", ".join(telling)
            + (" (at " + ", ".join(w for w in shared if w in places) + ")"
               if any(w in places for w in shared) else ""),
            "shared": shared}


def _sel_name(v):
    return v.get("name", "") if isinstance(v, dict) else str(v or "")


def _bare_addr(s):
    """'Name <a@b.com>' -> 'a@b.com'; anything else lowercased/trimmed.
    Without this, the '>' rides into the domain ('b.com>'), which never
    matches PUBLIC_MAIL_DOMAINS and would let two different public-mailbox
    users fold on 'the same' domain."""
    s = str(s or "").strip().lower()
    m = re.search(r"<([^<>@\s]+@[^<>\s]+)>", s)
    return m.group(1) if m else s


def senders_agree(incoming, existing):
    """True when the two items are safely the SAME counterparty.
    Missing on both sides counts as agreement (agent-generated tasks carry
    no sender). Missing on one side only does NOT: fold nothing you cannot
    attribute."""
    a = _bare_addr(incoming)
    b = _bare_addr(existing)
    if not a and not b:
        return True
    if not a or not b:
        return False
    if a == b:
        return True
    if "@" in a and "@" in b:
        da, db = a.rsplit("@", 1)[1], b.rsplit("@", 1)[1]
        return da == db and da not in PUBLIC_MAIL_DOMAINS
    return False


def decide(incoming_fields, open_rows):
    """The pure gate: given the create payload and the open board, say what
    to do. Returns {"action": "create"} or
    {"action": "update", "taskId", "matchedName"} or
    {"action": "create", "note": "..."} when a key match was deliberately
    not folded. No network in here — this is what the tests exercise."""
    key = dupe_task_key(incoming_fields.get(F["name"], ""))
    if not key:
        return {"action": "create", "key": key}
    incoming_sender = incoming_fields.get(F["inboundSender"], "")

    incoming_name = incoming_fields.get(F["name"], "")
    matches, why_matched = [], {}
    for row in open_rows:
        f = row.get("fields", {})
        if _sel_name(f.get(F["status"])) in CLOSED_STATUSES:
            continue
        other = f.get(F["name"], "")
        # TWO PASSES, and a match is either. The key is the fast exact bucket
        # and keeps every catch it already had; the verdict is the second pass
        # over what it missed — seven real pairs on the live queue of 28 Aug
        # 2026, each the same matter written two different ways.
        if dupe_task_key(other) == key:
            why_matched[row["id"]] = "same subject"
            matches.append(row)
            continue
        verdict = dupe_verdict(incoming_name, other, mode="fold")
        if verdict["match"]:
            why_matched[row["id"]] = verdict["why"]
            matches.append(row)

    if not matches:
        return {"action": "create", "key": key}

    matches.sort(key=lambda r: r.get("createdTime", ""))
    for row in matches:
        if senders_agree(incoming_sender, row.get("fields", {}).get(F["inboundSender"], "")):
            return {
                "action": "update",
                "key": key,
                "taskId": row["id"],
                "matchedName": row.get("fields", {}).get(F["name"], ""),
                # WHY it folded, in Kevin's words rather than a key. A fold he
                # cannot audit is a fold he has to take on trust.
                "matchedWhy": why_matched.get(row["id"], "same subject"),
            }
    return {
        "action": "create",
        "key": key,
        "note": ("subject matches %d open task(s) from a different sender; "
                 "not folding across counterparties. The page's Duplicates "
                 "lane flags the pair for Kevin." % len(matches)),
    }


def build_update(existing_fields, incoming_fields, today_iso):
    """The pure patch builder for a fold.

    - Description gains a dated update block (total capped well under
      Airtable's long-text limit; oldest history trims first).
    - FOLD TRACE: the incoming item's dedupe key (thread URL / imessage
      guid) is APPENDED to Inbound Note URL Link. Every dedupe that guards
      this pipeline — the skills' Step 3/5 FIND query and the Inbound Comms
      page's own check — matches that field by substring, so without this
      a folded thread reads as unhandled for ever and the stranded sweep
      refolds it three times a day. Space-separated on purpose: FIND still
      matches each URL, and the page's thread grouping reads the FIRST one,
      which stays the original thread.
    - Status: never moves a task OUT of Kevin's Approval queue. (The PATCH
      itself bumps Last Modified Time, so the Slack stale-approval guard
      makes Kevin re-read before approving — that is intended: new material
      on a matter he is about to sign off MUST force a re-read.)
    - Due date and Hard Deadline honour the hard-deadline contract: a hard
      deadline is a real-world date (court date, pay-by) that soft chaser
      dues must never drag around. A soft due only moves a soft due; a hard
      incoming date beats a soft existing one; two hard dates keep the
      earlier.
    - Priority only ever moves UP."""
    patch = {}
    add_desc = str(incoming_fields.get(F["desc"], "") or "").strip()[:6000]
    new_url = str(incoming_fields.get(F["inboundUrl"]) or "").strip()
    block = "\n\nUPDATE %s: new item folded in by the duplicate gate (one subject = one open task)." % today_iso
    if new_url:
        block += "\nSource: %s" % new_url
    if add_desc:
        block += "\n" + add_desc
    full = (str(existing_fields.get(F["desc"], "") or "").rstrip() + block).strip()
    if len(full) > 80000:
        full = "[earlier history trimmed by the duplicate gate]\n" + full[-80000:]
    patch[F["desc"]] = full

    old_url = str(existing_fields.get(F["inboundUrl"]) or "").strip()
    if new_url and new_url not in old_url:
        patch[F["inboundUrl"]] = (old_url + " " + new_url).strip()

    existing_status = _sel_name(existing_fields.get(F["status"]))
    if existing_status != "Approval":
        patch[F["status"]] = _sel_name(incoming_fields.get(F["status"])) or "Today"

    ex_due = str(existing_fields.get(F["due"]) or "")[:10]
    in_due = str(incoming_fields.get(F["due"]) or "")[:10]
    ex_hard = bool(existing_fields.get(F["hardDeadline"]))
    in_hard = bool(incoming_fields.get(F["hardDeadline"]))
    if in_hard and in_due:
        if not ex_hard:
            patch[F["due"]] = in_due
            patch[F["hardDeadline"]] = True
        elif not ex_due or in_due < ex_due:
            patch[F["due"]] = in_due
    elif not ex_hard and existing_status != "Approval":
        dues = [d for d in (ex_due, in_due) if d]
        if dues:
            patch[F["due"]] = min(dues)

    old_p = PRIORITY_RANK.get(_sel_name(existing_fields.get(F["priority"])), -1)
    new_p = PRIORITY_RANK.get(_sel_name(incoming_fields.get(F["priority"])), -1)
    if new_p > old_p:
        patch[F["priority"]] = _sel_name(incoming_fields.get(F["priority"]))
    return patch


# ── Airtable transport (network only below this line) ────────────────────

def pat():
    path = os.path.expanduser("~/.config/od/airtable_pat")
    with open(path) as fh:
        return fh.read().strip()


def _request(method, path, body=None):
    url = f"https://api.airtable.com/v0/{BASE_ID}{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        "Authorization": f"Bearer {pat()}",
        "Content-Type": "application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as e:
        raise RuntimeError(
            f"Airtable {method} {path} -> HTTP {e.code}: "
            f"{e.read().decode('utf-8', 'replace')[:300]}") from None


def fetch_open_tasks():
    """Every open task, paginated (the one lesson of the recon accuracy
    card: a hand-rolled read that skips the offset token scores one page).
    Server-side filter on Status only; the key match runs client-side, so a
    display-name rename cannot silently empty the gate."""
    records, offset = [], None
    while True:
        params = [("pageSize", "100"), ("returnFieldsByFieldId", "true"),
                  ("filterByFormula", "AND({Status}!='Completed', {Status}!='Cancelled')")]
        for fid in (F["name"], F["status"], F["due"], F["priority"],
                    F["team"], F["inboundSender"]):
            params.append(("fields[]", fid))
        if offset:
            params.append(("offset", offset))
        qs = urllib.parse.urlencode(params)
        data = _request("GET", f"/{TASKS}?{qs}")
        records.extend(data.get("records", []))
        offset = data.get("offset")
        if not offset:
            return records


def post_comment(task_id, text):
    try:
        _request("POST", f"/{TASKS}/{task_id}/comments", {"text": text[:4000]})
    except Exception as e:  # best-effort trail, same as the page's comment
        print(f"comment failed (non-fatal): {e}", file=sys.stderr)


def cmd_create(fields, force=False, dry_run=False):
    if F["name"] not in fields or not str(fields[F["name"]]).strip():
        print("fields JSON must carry the Task Name field " + F["name"], file=sys.stderr)
        return 1

    verdict = {"action": "create", "key": dupe_task_key(fields.get(F["name"], ""))}
    if not force:
        rows = fetch_open_tasks()
        if not rows:
            # CONTROL: the board carries hundreds of open tasks at all times.
            print("GATE COULD NOT RUN: open-tasks read returned zero rows "
                  "(expected hundreds) — check the Status field name. "
                  "Nothing was created; count this item unhandled.", file=sys.stderr)
            return 2
        verdict = decide(fields, rows)

    if verdict["action"] == "update":
        task_id = verdict["taskId"]
        live = _request("GET", f"/{TASKS}/{task_id}?returnFieldsByFieldId=true")
        patch = build_update(live.get("fields", {}), fields, date.today().isoformat())
        if not dry_run:
            _request("PATCH", f"/{TASKS}/{task_id}",
                     {"typecast": True, "fields": patch})
            post_comment(task_id,
                         "Duplicate gate: folded a new item into this task instead of "
                         "creating a sibling (one subject = one open task). "
                         "New item: " + str(fields.get(F["name"], "")))
        print(json.dumps({"action": "updated", "taskId": task_id,
                          "matchedName": verdict.get("matchedName", ""),
                          "key": verdict.get("key", ""), "dryRun": dry_run}))
        return 0

    if not dry_run:
        created = _request("POST", f"/{TASKS}", {"typecast": True, "fields": fields})
        task_id = created.get("id", "")
    else:
        task_id = "(dry run)"
    out = {"action": "created", "taskId": task_id, "key": verdict.get("key", ""),
           "dryRun": dry_run}
    if verdict.get("note"):
        out["note"] = verdict["note"]
    print(json.dumps(out))
    return 0


def cmd_check(name):
    rows = fetch_open_tasks()
    if not rows:
        print("GATE COULD NOT RUN: open-tasks read returned zero rows", file=sys.stderr)
        return 2
    print(json.dumps(decide({F["name"]: name}, rows)))
    return 0


def selftest():
    checks = []

    def check(label, cond):
        checks.append((label, bool(cond)))

    k = dupe_task_key
    check("references collide", k("Chase Acme invoice #2") == k("Chase Acme invoice #3"))
    check("brand digits kept", "v12" in k("Renew v12 licence"))
    check("pure digits dropped", "4471902" not in k("Pay ref 4471902"))
    check("empty name empty key", k("") == "" and k("#12345") == "")

    def row(rid, name, status="Today", sender="", created="2026-08-01T00:00:00.000Z"):
        return {"id": rid, "createdTime": created, "fields": {
            F["name"]: name, F["status"]: {"name": status}, F["inboundSender"]: sender}}

    incoming = {F["name"]: "INBOUND: Outstanding invoices",
                F["inboundSender"]: "billing@acmecollections.co.uk",
                F["status"]: "Today", F["desc"]: "Second chaser.",
                F["priority"]: "Urgent", F["due"]: "2026-08-25"}

    same = row("rec1", "INBOUND: Outstanding invoices #2", sender="legal@acmecollections.co.uk")
    other = row("rec2", "INBOUND: Outstanding invoices", sender="accounts@othercorp.com")
    closed = row("rec3", "INBOUND: Outstanding invoices", status="Completed",
                 sender="billing@acmecollections.co.uk")

    check("same private domain folds", decide(incoming, [same])["action"] == "update")
    d = decide(incoming, [other])
    check("different sender creates with a note", d["action"] == "create" and "note" in d)
    check("closed tasks never match", decide(incoming, [closed])["action"] == "create")
    check("no sender vs sender does not fold",
          decide({F["name"]: "INBOUND: Outstanding invoices"}, [same])["action"] == "create")
    check("no sender both sides folds",
          decide({F["name"]: "Weekly cost review"},
                 [row("rec4", "Weekly cost review")])["action"] == "update")
    gmail_a = {F["name"]: "INBOUND: school fees", F["inboundSender"]: "a@gmail.com"}
    gmail_b = row("rec5", "INBOUND: school fees", sender="b@gmail.com")
    check("public domain never folds on domain alone",
          decide(gmail_a, [gmail_b])["action"] == "create")
    oldest = [row("recB", "Chase Acme invoice #9", sender="x@acme.com",
                  created="2026-08-20T00:00:00.000Z"),
              row("recA", "Chase Acme invoice #8", sender="x@acme.com",
                  created="2026-08-10T00:00:00.000Z")]
    check("oldest open task is the canonical fold target",
          decide({F["name"]: "Chase Acme invoice #10",
                  F["inboundSender"]: "y@acme.com"}, oldest)["taskId"] == "recA")

    existing = {F["desc"]: "Original ask.", F["status"]: {"name": "This Week"},
                F["due"]: "2026-08-28", F["priority"]: {"name": "High"}}
    p = build_update(existing, incoming, "2026-08-25")
    check("description appends, keeps original",
          p[F["desc"]].startswith("Original ask.") and "Second chaser." in p[F["desc"]])
    check("status refreshes to Today", p[F["status"]] == "Today")
    check("earliest due wins", p[F["due"]] == "2026-08-25")
    check("priority only moves up", p[F["priority"]] == "Urgent")
    approval = {F["desc"]: "With Kevin.", F["status"]: {"name": "Approval"},
                F["due"]: "2026-08-28", F["priority"]: {"name": "Urgent"}}
    p2 = build_update(approval, incoming, "2026-08-25")
    check("a task at Approval keeps its status and soft due",
          F["status"] not in p2 and F["due"] not in p2)
    check("priority never downgrades", F["priority"] not in p2)

    check("bracketed sender folds with its bare form",
          senders_agree("Alice Smith <billing@acme.com>", "billing@acme.com"))
    check("two different public-mailbox users never fold, bracketed or not",
          not senders_agree("Alice <alice@gmail.com>", "Bob <bob@gmail.com>"))

    inc_url = dict(incoming)
    inc_url[F["inboundUrl"]] = "https://mail.google.com/mail/u/0/#all/THREAD2"
    ex_url = {F["desc"]: "x", F["status"]: {"name": "Today"},
              F["inboundUrl"]: "https://mail.google.com/mail/u/0/#all/THREAD1"}
    pu = build_update(ex_url, inc_url, "2026-08-25")
    check("fold trace: new thread URL appended to the dedupe field",
          pu[F["inboundUrl"]].endswith("#all/THREAD2") and "#all/THREAD1" in pu[F["inboundUrl"]])
    ex_same = dict(ex_url)
    ex_same[F["inboundUrl"]] = inc_url[F["inboundUrl"]]
    check("fold trace: an already-recorded URL is not appended twice",
          F["inboundUrl"] not in build_update(ex_same, inc_url, "2026-08-25"))

    hard_ex = {F["desc"]: "court", F["status"]: {"name": "Today"},
               F["due"]: "2026-09-10", F["hardDeadline"]: True}
    soft_in = {F["name"]: "chaser", F["desc"]: "chase", F["status"]: "Today",
               F["due"]: "2026-08-25"}
    check("a soft chaser never drags a hard deadline's date",
          F["due"] not in build_update(hard_ex, soft_in, "2026-08-25"))
    hard_in = dict(soft_in)
    hard_in[F["hardDeadline"]] = True
    hard_in[F["due"]] = "2026-09-01"
    soft_ex = {F["desc"]: "x", F["status"]: {"name": "Today"}, F["due"]: "2026-09-15"}
    ph = build_update(soft_ex, hard_in, "2026-08-25")
    check("a hard incoming date beats a soft due and carries the flag",
          ph[F["due"]] == "2026-09-01" and ph[F["hardDeadline"]] is True)
    both = build_update(hard_ex, hard_in, "2026-08-25")
    check("two hard dates keep the earlier", both[F["due"]] == "2026-09-01")
    apv_hard = {F["desc"]: "x", F["status"]: {"name": "Approval"}, F["due"]: "2026-09-15"}
    pa = build_update(apv_hard, hard_in, "2026-08-25")
    check("a hard deadline updates due even at Approval, without moving status",
          pa[F["due"]] == "2026-09-01" and F["status"] not in pa)

    failed = [label for label, ok in checks if not ok]
    print(json.dumps({"checks": len(checks), "failed": failed}))
    return 1 if failed else 0


def main(argv):
    if not argv:
        print(__doc__)
        return 1
    cmd = argv[0]
    if cmd == "selftest":
        return selftest()
    if cmd == "check":
        if len(argv) < 3 or argv[1] != "--name":
            print("usage: check --name '<task name>'", file=sys.stderr)
            return 1
        return cmd_check(argv[2])
    if cmd == "create":
        fields, force, dry = None, False, False
        i = 1
        while i < len(argv):
            if argv[i] == "--fields-json":
                fields = json.loads(argv[i + 1]); i += 2
            elif argv[i] == "--force":
                force = True; i += 1
            elif argv[i] == "--dry-run":
                dry = True; i += 1
            else:
                print(f"unknown flag {argv[i]}", file=sys.stderr); return 1
        if fields is None:
            print("create needs --fields-json", file=sys.stderr)
            return 1
        return cmd_create(fields, force=force, dry_run=dry)
    print(f"unknown command {cmd}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
