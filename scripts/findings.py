#!/usr/bin/env python3
"""The single queue of things the routines found but are no longer allowed to fix.

Every scheduled routine is read-only with respect to code. When one spots a
problem it appends a finding here and moves on. One fixer run later drains this
queue, in one worktree, behind one lock, into one pull request.

The file lives in ~/knowledge-os/logs, NOT in the repo. The repo is public, and
sweep output has already leaked tenant data into it once. Findings quote real
records, so they stay off GitHub.

Usage
    findings.py add --routine drift-monitor --title "..." --where js/config.js:42 \
                    --detail "..." --fix "..." [--severity high] [--agent "<agent name>"]
    findings.py list [--status open] [--routine X] [--json]
    findings.py claim <id> --by queue-fixer
    findings.py reopen <id> [--force] | findings.py reopen --stale
    findings.py list --stale
    findings.py close <id> --outcome fixed --evidence <sha> --note "..."
    findings.py close <id> --outcome pending --pr <n> --note "..."
    findings.py close <id> --outcome rejected|deferred --note "..." [--until YYYY-MM-DD]
    findings.py close <id> --outcome tasked --task <rec id> --note "..."
    findings.py dupe <id> --of <survivor id> --note "..."   # the same problem, filed again
    findings.py undupe <id> --note "..."                    # take a merge back
    findings.py retag <id> --code|--not-code --note "..."   # correct the filer's guess
    findings.py escalate <id> --severity critical --why "..." [--by task-manager]
    findings.py overflow list|sort [--apply]|promote <ref>|dismiss <ref> --note "..."
    findings.py overflow fold <ref> --into <finding id | ofl- ref>   # a reader's match
    findings.py count                 # the BACKLOG: open + claimed + pending
    findings.py count --status all    # every finding ever filed
    findings.py count --breakdown     # every status, labelled
"""

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime

HOME = os.path.expanduser("~")
FINDINGS = os.environ.get(
    "FINDINGS_FILE", os.path.join(HOME, "knowledge-os/logs/findings-queue.jsonl")
)

SEVERITIES = ["critical", "high", "medium", "low"]
# `pending` is a fix that is WRITTEN but not LANDED. It is not open (the fixer
# must not redo it) and it is not fixed (nothing reached production yet).
OPEN_STATES = ["open", "claimed", "pending"]

# Anything at or above this severity is always accepted, cap or no cap. A
# production break must never be refused because a routine's queue is untidy.
ALWAYS_ACCEPT = ("critical", "high")

# ─── WHY THERE IS A CAP AT ALL (26 Aug 2026, Kevin's restructure) ────
#
# Measured over the 18 days to 26 Aug 2026: the routines filed 364 findings and
# closed 168. Phase 8 fixes at most ten a day; the sweeps produced about twenty.
# Net growth +196, ending at 202 open — 3 critical, 53 high, 36 of them older
# than a fortnight. A queue fed at twenty and drained at ten has one possible
# future, and the routine's main output had become a backlog nothing could
# reach.
#
# Worse, the drain was not even ten. PRs #107, #110, #126 and #137 were all
# still OPEN and unmerged on 26 Aug while forty findings sat closed as "fixed"
# citing them. The queue was reporting work as done that had never landed.
#
# Two answers, both here:
#   1. A cap, so a routine cannot file unboundedly into a queue nobody reaches.
#      Refused findings are NOT lost — they go to the overflow log, and the
#      refusal says so. Losing the information would be its own bug.
#   2. `pending`, so a written-but-unmerged fix stops counting as fixed.
MAX_OPEN_PER_ROUTINE = 15
OVERFLOW = os.environ.get(
    "FINDINGS_OVERFLOW_FILE",
    os.path.join(HOME, "knowledge-os/logs/findings-overflow.jsonl"),
)

# ─── ONE PROBLEM, ONE LINE; A FILER IS AN AGENT, NOT A LANE (14 Oct 2026) ─
#
# Kevin, 14 Oct 2026: "merge duplicates, move the non-code items to tasks, stop
# the overflow log". Measured that day: 235 open, of which about a fifth were
# the same problem filed again (one insurer's sign-in window three times, one findings
# cap four times), 62 were flagged as needing no code at all (a council tax
# hearing, an insurance gap, tenancy data) so the code fixer could never close
# them, and 89 came from AI agents who all file under ONE routine name,
# `agent-dispatch`. With a cap of 15 per routine, every medium or low finding
# any agent filed went to the overflow log: 245 lines, nothing read them.
#
# Four answers, all here:
#   1. `dupe` merges a repeat into the finding that survives. The repeat leaves
#      every backlog count but keeps its words on the survivor, and it takes
#      the survivor's final state when that closes, so a robot's TOOL wall on
#      the repeat still wakes when the fix lands (agent-dispatch.py clears a
#      wall only on `fixed`). `undupe` takes it back.
#   2. `tasked` closes a finding a code fix cannot close, against the open task
#      that now carries it. The task is read off Airtable first.
#   3. `deferred --until` comes back by itself on its date, so a park is a
#      clock and not a burial.
#   4. The cap counts per FILER: the routine plus the agent that names itself
#      (`--agent`, or FINDINGS_AGENT). A refusal gets a reference and stays
#      "refused, unread" on the Defects card until a reader promotes it,
#      dismisses it, or `overflow sort --apply` folds it into the open finding
#      it repeats.
DUPLICATE = "duplicate"
TASKED = "tasked"
# Closed states a repeat takes from its survivor. Pending is NOT here: a fix in
# an open PR is still owed, so the repeat stays `duplicate` until it lands.
FINAL_STATES = ("fixed", "rejected", "deferred", TASKED)
TASK_ID_RE = re.compile(r"^rec[A-Za-z0-9]{14}$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
AIRTABLE_BASE = "appnqjDpqDniH3IRl"
TASKS_TABLE = "tblqB8b22hKBL4PF1"
TEAM_TABLE = "Team Members"
PAT_FILE = os.path.expanduser("~/.config/od/airtable_pat")

# A NAME IS NOT AN AGENT (review of PR #784, 14 Oct 2026). With the cap per agent, 17
# mediums under one routine with 17 invented --agent names were all accepted. So a name
# counts as an agent only when it is one: a Team Members row with Is AI Agent ticked
# (read at most once a day, cached), or an agent definition file in ~/.claude/agents.
# Anything else is no agent, counted in the routine's shared pool. And whatever the
# names, one routine never holds more than ROUTINE_CEILING open below high.
ROUTINE_CEILING = 3 * MAX_OPEN_PER_ROUTINE
AGENTS_CACHE = os.environ.get(
    "FINDINGS_AGENTS_CACHE", os.path.join(HOME, "knowledge-os/logs/findings-agents-cache.json"))
AGENTS_DIR = os.environ.get("FINDINGS_AGENTS_DIR", os.path.join(HOME, ".claude/agents"))
AGENTS_CACHE_HOURS = 24

# ─── A CLAIM THAT OUTLIVES ITS RUN ───────────────────────────────────
#
# 14 Aug 2026, finding 20260814-daily-ops-144. A fixer run claims a finding,
# then dies — the Mac sleeps, an agent stalls, the context runs out. The
# finding is now "claimed" for ever: `list --status open` cannot see it, no
# run will ever pick it up again, and the only recovery was hand-editing the
# append-only log. Findings went quiet without being fixed, which is worse
# than a long queue because a long queue is visible.
#
# A claim is therefore a LEASE, not a transfer of ownership. Past this many
# hours with no close, the finding goes back in the queue. Comfortably longer
# than a real run (daily-ops takes an hour or two) and comfortably shorter
# than a day, so a finding stranded this morning is back before tomorrow's run.
STALE_CLAIM_HOURS = 12


def iso():
    return datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")


def ensure():
    os.makedirs(os.path.dirname(FINDINGS), exist_ok=True)


def read_all():
    ensure()
    if not os.path.exists(FINDINGS):
        return []
    out = []
    with open(FINDINGS) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return out


def append(rec):
    ensure()
    with open(FINDINGS, "a") as f:
        f.write(json.dumps(rec) + "\n")


def today_str():
    """Today's date where the Mac is. FINDINGS_TODAY pins it for tests."""
    return os.environ.get("FINDINGS_TODAY") or datetime.now().strftime("%Y-%m-%d")


def norm_agent(agent):
    """An agent's name as the cap keys it: 'Property Administration',
    'property-administration' and 'AI Property Administration' are one filer."""
    n = re.sub(r"[^a-z0-9]", "", (agent or "").lower())
    return n[2:] if n.startswith("ai") and len(n) > 2 else n


def _team_agent_names():
    """Names of the Team Members rows with Is AI Agent ticked, paginated. Raises on a bad read."""
    with open(PAT_FILE) as fh:
        pat = fh.read().strip()
    names, offset = [], None
    while True:
        q = [("filterByFormula", "{Is AI Agent}"), ("fields[]", "Name"), ("pageSize", "100")]
        if offset:
            q.append(("offset", offset))
        req = urllib.request.Request("https://api.airtable.com/v0/%s/%s?%s" % (
            AIRTABLE_BASE, urllib.parse.quote(TEAM_TABLE), urllib.parse.urlencode(q)),
            headers={"Authorization": "Bearer " + pat})
        with urllib.request.urlopen(req, timeout=30) as r:
            d = json.load(r)
        names += [(x.get("fields") or {}).get("Name") or "" for x in d.get("records") or []]
        offset = d.get("offset")
        if not offset:
            break
    if not any(names):
        # Zero AI agents means the read broke, never an estate with no agents.
        raise RuntimeError("the Team Members read returned no AI agents")
    return [n for n in names if n]


def known_agents(now=None):
    """(normalised name -> display name, problem). The Team Members list comes from a cache
    refreshed at most once a day; a failed refresh keeps the last good list and says so."""
    now = now or datetime.utcnow()
    out, problem, cached = {}, "", None
    try:
        with open(AGENTS_CACHE) as fh:
            cached = json.load(fh)
    except (OSError, ValueError):
        cached = None
    age = age_hours((cached or {}).get("fetchedAt"), now) if cached else None
    names = (cached or {}).get("names") or []
    if age is None or age >= AGENTS_CACHE_HOURS:
        try:
            names = _team_agent_names()
            tmp = AGENTS_CACHE + ".tmp"
            os.makedirs(os.path.dirname(AGENTS_CACHE), exist_ok=True)
            with open(tmp, "w") as fh:
                json.dump({"fetchedAt": now.strftime("%Y-%m-%dT%H:%M:%SZ"), "names": names}, fh)
            os.replace(tmp, AGENTS_CACHE)
        except Exception as e:  # noqa: BLE001 — said, and the last good list is kept
            problem = "the AI agent list could not be refreshed (%s)%s" % (
                str(e)[:120], "; using the cached list" if names else "")
    for n in names:
        out[norm_agent(n)] = n
    try:
        for f in os.listdir(AGENTS_DIR):
            if f.endswith(".md") and f[:-3] == f[:-3].lower():
                out.setdefault(norm_agent(f[:-3]), f[:-3])
    except OSError:
        pass
    out.pop("", None)
    return out, problem


def resolve_agent(agent):
    """(the agent's display name or '', a note). An unknown name is no agent."""
    agent = (agent or "").strip()
    if not agent:
        return "", ""
    known, problem = known_agents()
    hit = known.get(norm_agent(agent))
    if hit:
        return hit, problem
    return "", ("%r is not an AI agent on the Team Members list or in ~/.claude/agents, so this is "
                "counted in the routine's shared pool.%s" % (agent, (" " + problem) if problem else ""))


def current_state(today=None):
    """Fold the append-only log into the current state of each finding.

    Append-only rather than rewrite-in-place: two routines writing findings at
    the same moment must never truncate each other's work, and the history of
    what was found and when survives a bad fixer run.
    """
    state = {}
    for rec in read_all():
        fid = rec.get("id")
        if not fid:
            continue
        if rec.get("op") == "add":
            state[fid] = dict(rec, status="open")
        elif fid in state:
            if rec.get("op") in ("close", "land", "reopen"):
                # A decision on the finding itself ends any merge: closing a
                # repeat in its own right, or reopening it, is the reader saying
                # it stands alone again.
                state[fid].pop("duplicate_of", None)
            if rec.get("op") == "dupe":
                state[fid]["duplicate_of"] = rec.get("of")
                state[fid]["dupe_at"] = rec.get("ts")
                state[fid]["dupe_note"] = rec.get("note")
            elif rec.get("op") == "undupe":
                state[fid].pop("duplicate_of", None)
                state[fid]["undupe_note"] = rec.get("note")
            elif rec.get("op") == "retag":
                # The filer's guess at code / not code corrected by a reader.
                # The Defects card splits on it, so a wrong flag is a wrong card.
                state[fid]["touches_code"] = bool(rec.get("touches_code"))
                state[fid]["retag_note"] = rec.get("note")
                state[fid]["retagged"] = True
            elif rec.get("op") == "claim":
                state[fid]["status"] = "claimed"
                state[fid]["claimed_by"] = rec.get("by")
                state[fid]["claimed_at"] = rec.get("ts")
            elif rec.get("op") == "reopen":
                state[fid]["status"] = "open"
                state[fid].pop("claimed_by", None)
                state[fid].pop("claimed_at", None)
                state[fid].pop("deferred_until", None)
                state[fid]["reopen_note"] = rec.get("note")
            elif rec.get("op") == "recur":
                # Seen again. Evidence about an existing finding, never a new
                # one. Severity only ever ratchets UP: a defect that turns out
                # to be critical on its third sighting is critical.
                state[fid]["seen"] = state[fid].get("seen", 1) + 1
                state[fid]["last_seen"] = rec.get("ts")
                # Keep what the recurrence SAID, not just that it happened
                # (finding 20261012-agent-dispatch-840). A fold threw away the
                # filer's --fix, so a fixer taking the finding read only the
                # original fix text: on 12 Oct 2026 finding 681 still showed
                # its 30 Sep fix while the cause found on 12 Oct survived in a
                # scratch file nothing reads, so the fix that shipped would
                # have left the live bug alone.
                if rec.get("note") or rec.get("fix"):
                    state[fid].setdefault("recurrences", []).append(
                        {"ts": rec.get("ts"), "note": rec.get("note") or "",
                         "fix": rec.get("fix") or ""})
                old_sev, new_sev = state[fid].get("severity"), rec.get("severity")
                if (new_sev in SEVERITIES and old_sev in SEVERITIES
                        and SEVERITIES.index(new_sev) < SEVERITIES.index(old_sev)):
                    state[fid]["severity"] = new_sev
            elif rec.get("op") == "escalate":
                # Raised by a clock (task-manager.py clock, 7 Oct 2026): a robot
                # has waited on this fix past its wall's clock. Like a
                # recurrence, severity only ever ratchets UP.
                old_sev, new_sev = state[fid].get("severity"), rec.get("severity")
                if (new_sev in SEVERITIES and (old_sev not in SEVERITIES
                                               or SEVERITIES.index(new_sev) < SEVERITIES.index(old_sev))):
                    state[fid]["severity"] = new_sev
                state[fid]["escalated_at"] = rec.get("ts")
                state[fid]["escalated_why"] = rec.get("why")
            elif rec.get("op") == "land":
                # The PR carrying this fix actually merged.
                state[fid]["status"] = "fixed"
                state[fid]["landed_at"] = rec.get("ts")
                state[fid]["landed_pr"] = rec.get("pr")
            elif rec.get("op") == "close":
                outcome = rec.get("outcome", "closed")
                # "pending" is written but NOT landed. It stays out of the open
                # queue so the fixer does not redo it, and out of the fixed
                # count so nobody reads unmerged work as finished.
                state[fid]["status"] = "pending" if outcome == "pending" else outcome
                state[fid]["close_note"] = rec.get("note")
                state[fid]["closed_at"] = rec.get("ts")
                if rec.get("pr"):
                    state[fid]["pr"] = rec.get("pr")
                if rec.get("task"):
                    state[fid]["task"] = rec.get("task")
                if outcome == "deferred" and rec.get("until"):
                    state[fid]["deferred_until"] = rec.get("until")
                else:
                    state[fid].pop("deferred_until", None)
    # A park with a date is a clock (Kevin, 7 Oct 2026: no lane without a
    # clock). On its date it is open again, with no job needed to wake it.
    day = today or today_str()
    for r in state.values():
        until = r.get("deferred_until")
        if r.get("status") == "deferred" and until and until <= day:
            r["status"] = "open"
            r["woke_from_deferral"] = until
    _fold_duplicates(state)
    return state


def duplicate_root(state, fid, limit=50):
    """The finding a repeat finally points at, or None for a pointer to a
    missing finding or a loop (never followed for ever, never guessed)."""
    seen = {fid}
    cur = fid
    for _ in range(limit):
        nxt = (state.get(cur) or {}).get("duplicate_of")
        if not nxt:
            return cur
        if nxt not in state or nxt in seen:
            return None
        seen.add(nxt)
        cur = nxt
    return None


def survivor_status(state, fid):
    """(id, status) a wall citing FID is judged by: FID itself, or for a merged repeat the
    survivor it points at, whatever that survivor's state. ('', '') for an unknown id.
    THE one place this is decided (review of PR #784): the Task Board Manager's clock reads
    it, and agent-dispatch.py's finding_states should read it too once PR #780 lands."""
    r = state.get(fid)
    if not r:
        return "", ""
    root = r.get("duplicate_root")
    if root and root in state:
        return root, state[root].get("status", "")
    return fid, r.get("status", "")


def _fold_duplicates(state):
    """Give each repeat its survivor's standing and each survivor its repeats'
    evidence. Done after every op is folded, so `undupe` needs no undo: drop
    the pointer and the evidence is simply never attached."""
    roots = {fid: duplicate_root(state, fid) for fid, r in state.items() if r.get("duplicate_of")}
    for fid in sorted(roots, key=lambda i: (state[i].get("dupe_at") or "", i)):
        r, root = state[fid], roots[fid]
        if root is None:
            r["duplicate_broken"] = True     # shown at its own status, so nothing hides
            continue
        rr = state[root]
        r["duplicate_root"] = root
        r["status"] = DUPLICATE if rr.get("status") in OPEN_STATES else rr.get("status")
        rr.setdefault("duplicates", []).append(fid)
        rr["seen"] = rr.get("seen", 1) + r.get("seen", 1)
        rr["last_seen"] = max(rr.get("last_seen") or rr.get("ts") or "",
                              r.get("last_seen") or r.get("ts") or "")
        old_sev, new_sev = rr.get("severity"), r.get("severity")
        if (new_sev in SEVERITIES and (old_sev not in SEVERITIES
                                       or SEVERITIES.index(new_sev) < SEVERITIES.index(old_sev))):
            rr["severity"] = new_sev
        # A repeat that needs code makes the problem a code problem, unless a reader has
        # retagged the survivor itself: an explicit decision on the problem beats a
        # filer's guess on one of its reports (review of PR #784, finding 868 read as
        # code because its repeat 873 did).
        if not rr.get("retagged"):
            rr["touches_code"] = bool(rr.get("touches_code") or r.get("touches_code"))
        words = " ".join(x for x in (
            "Repeat %s (%s, %s): %s" % (fid, r.get("routine") or "?", (r.get("ts") or "?")[:10], r.get("title") or ""),
            ("Where: %s" % r["where"]) if r.get("where") else "",
            r.get("detail") or "") if x)
        rr.setdefault("recurrences", []).append(
            {"ts": r.get("ts"), "note": words, "fix": r.get("proposed_fix") or "", "from": fid})
        for rc in r.get("recurrences") or []:
            rr["recurrences"].append(dict(rc, **{"from": fid}))


def dedupe_key(routine, title, where):
    """What makes two findings THE SAME finding.

    The sweeps already do this by hand against Airtable — "appended a dated
    recurrence line to the existing task rather than raising a duplicate" — and
    the findings queue had no equivalent, so the same defect was filed over and
    over. `cfv_{id}_startDate has no writer` went in three separate times and
    all three sat open at once.

    Normalise hard: lowercase, collapse whitespace, drop punctuation. A title
    reworded slightly between runs is still the same defect.
    """
    def norm(v):
        # Each field is normalised on its OWN, then joined. Normalising the
        # joined string instead lets the separator glue to a neighbouring token
        # ("writer!|js" collapses differently from "writer|js"), so two
        # identical findings get different keys and both are filed.
        keep = [c if (c.isalnum() or c.isspace()) else " " for c in (v or "").lower()]
        return " ".join("".join(keep).split())

    return "|".join(norm(v) for v in (routine, title, where))


# ─── WHEN ONE DEFECT IS FILED SIX TIMES (finding 639, 27 Sep 2026) ───
#
# `dedupe_key` above keys on routine + title + where, so it only catches the
# SAME routine reporting the SAME defect in near-identical words. It did not
# catch this:
#
#   554 task-manager-board  "submit gate rejects CLOSE PROPOSAL on OD post cards"
#   598 task-manager-board  "od_picture_problem blocks closing a stale CONTENT (OD) card"
#   614 task-manager-board  "OD post-card gate blocks a CLOSE PROPOSAL, not just a POST"
#   633 task-manager-board  "Gate cleanse cannot close a stale OD content card ..."
#   634 task-manager-board  "od_picture_problem gate blocks CLOSE PROPOSAL submissions ..."
#   636 task-manager-board  "submit refuses a CLOSE PROPOSAL on an OD content card ..."
#   639 daily-ops-phase2    "... has been filed SIX times since 19 Sep and never fixed"
#
# One bug, one agreed one-line fix, seven ids across two routines and nineteen
# days. The queue got WIDER instead of LOUDER, which is the opposite of what a
# recurring defect should do: seven low-severity findings look like seven small
# things, and the one thing they actually are never rose up the list.
#
# WHAT THIS CAN AND CANNOT DO, honestly. Two of those seven name the symbol
# `od_picture_problem` in `where`; the rest describe it in prose ("the OD-post
# picture-link check", "the image-link guard"). No textual rule matches prose to
# a symbol, and pretending otherwise would be worse than the gap. So there are
# two mechanisms, and only the first merges anything:
#
#   1. SAME FILE AND SAME SYMBOL → a recurrence on the existing finding. A
#      symbol is specific enough that two findings naming both the same file
#      and the same function are about the same code.
#   2. SAME FILE ALONE → NOT merged, because one file holds many defects
#      (agent-dispatch.py has six unrelated open findings against it today).
#      Instead the new finding records the open ids that already name that
#      file, and `list` prints them. The fixer reading the queue then sees
#      "also open on this file: 598, 614, 633" at the point of decision.
#
# Matching on the file alone would have folded finding 615 (a slowdown budget)
# into finding 623 (the duplicate gate) purely because both name
# agent-dispatch.py. That is why rule 2 reports rather than merges.

CODE_PATH_RE = re.compile(
    r"\b([\w./-]+\.(?:py|js|mjs|cjs|ts|html|css|sh|json|yml|yaml|toml))\b")
# A symbol worth matching on: snake_case or camelCase, at least two parts, so
# bare English words ("submit", "gate", "close") never key anything. Those are
# exactly the words the prose findings used, and they are not specific enough.
SYMBOL_RE = re.compile(r"\b(?:[a-z]+(?:_[a-z0-9]+)+|[a-z]+[A-Z][A-Za-z0-9]*)\b")


def code_paths(where):
    """Every file path named in a finding's `where`, lowercased."""
    return {m.group(1).lower() for m in CODE_PATH_RE.finditer(where or "")}


def code_symbols(where):
    """Multi-part identifiers named in `where`, minus the file paths themselves."""
    text = CODE_PATH_RE.sub(" ", where or "")
    return {m.group(0) for m in SYMBOL_RE.finditer(text)}


def same_code_target(a_where, b_where):
    """True when two findings name the same file AND the same symbol in it."""
    pa, pb = code_paths(a_where), code_paths(b_where)
    if not pa or not (pa & pb):
        return False
    sa, sb = code_symbols(a_where), code_symbols(b_where)
    return bool(sa and (sa & sb))


def open_sharing_file(state, where, exclude_id=None):
    """Open findings that name at least one of the same files. Reported, never
    merged — see rule 2 above."""
    mine = code_paths(where)
    if not mine:
        return []
    out = []
    for r in state.values():
        if r.get("status") not in OPEN_STATES or r.get("id") == exclude_id:
            continue
        if code_paths(r.get("where")) & mine:
            out.append(r["id"])
    return sorted(out)


def open_findings_for(state, routine, agent=""):
    """The filer's own open findings: the routine AND the agent that named
    itself (or, for a filer that names none, the routine's unnamed ones).
    Fourteen agents filing under `agent-dispatch` shared one cap of 15, so
    every medium any of them filed was refused (14 Oct 2026)."""
    me = norm_agent(agent)
    return [r for r in state.values()
            if r.get("routine") == routine and r.get("status") in OPEN_STATES
            and norm_agent(r.get("agent")) == me]


def live_target(state, r):
    """The open finding a match on R should land on: R itself, or the survivor
    R was merged into. None when that survivor is no longer open."""
    if r.get("status") in OPEN_STATES:
        return r["id"]
    if r.get("status") == DUPLICATE and r.get("duplicate_root"):
        root = state.get(r["duplicate_root"]) or {}
        return root.get("id") if root.get("status") in OPEN_STATES else None
    return None


def next_id(routine):
    n = sum(1 for r in read_all() if r.get("op") == "add") + 1
    return "%s-%s-%03d" % (datetime.now().strftime("%Y%m%d"), routine[:24], n)


def age_hours(ts, now=None):
    """Hours since an ISO stamp. None when it cannot be read — never 0, because
    an unreadable stamp must not silently look fresh."""
    if not ts:
        return None
    try:
        when = datetime.strptime(ts, "%Y-%m-%dT%H:%M:%SZ")
    except (ValueError, TypeError):
        return None
    now = now or datetime.utcnow()
    return (now - when).total_seconds() / 3600.0


def is_stale_claim(rec, hours=STALE_CLAIM_HOURS, now=None):
    """Is this finding claimed by a run that is never coming back?

    A claim with no readable timestamp counts as stale. The alternative is to
    treat it as fresh for ever, which is the exact bug being fixed.
    """
    if rec.get("status") != "claimed":
        return False
    age = age_hours(rec.get("claimed_at"), now)
    return age is None or age >= hours


def known_match(state, routine, title, where):
    """(target id, why) for the open finding this one repeats, or (None, '').
    A repeat of a merged finding lands on its survivor."""
    key = dedupe_key(routine, title, where)
    # 1. Same routine, same words, same place.
    for r in state.values():
        tid = live_target(state, r)
        if tid and dedupe_key(r.get("routine"), r.get("title"), r.get("where")) == key:
            return tid, ""
    # 1b. Same FILE and same SYMBOL, whatever the routine or the wording. See
    #     the block above code_paths for why this is narrower than "same file"
    #     and why it has to be.
    for r in state.values():
        tid = live_target(state, r)
        if tid and same_code_target(where, r.get("where")):
            return tid, "same code target (%s)" % ", ".join(
                sorted(code_paths(where) & code_paths(r.get("where"))))
    return None, ""


def file_finding(state, f, cap=True):
    """File one finding: a recurrence of an open one, a refusal past the
    filer's cap, or a new id. Returns (exit code, id or overflow ref)."""
    key = dedupe_key(f["routine"], f["title"], f["where"])
    tid, why = known_match(state, f["routine"], f["title"], f["where"])
    if tid:
        # A defect seen again is evidence about that defect, never a second one.
        append({"op": "recur", "id": tid, "ts": iso(),
                "severity": f["severity"], "note": f["detail"], "fix": f["fix"]})
        print(tid)
        print("RECURRENCE of %s (seen %d times)%s — no duplicate filed."
              % (tid, state[tid].get("seen", 1) + 1, (" — " + why) if why else ""),
              file=sys.stderr)
        return 0, tid

    # 2. Cap the FILER's own open queue, and the routine as a whole. Critical and
    #    high are never refused.
    if cap and f["severity"] not in ALWAYS_ACCEPT:
        mine = open_findings_for(state, f["routine"], f.get("agent"))
        lane = [r for r in state.values()
                if r.get("routine") == f["routine"] and r.get("status") in OPEN_STATES]
        if len(mine) >= MAX_OPEN_PER_ROUTINE or len(lane) >= ROUTINE_CEILING:
            rec = {"op": "overflow", "ts": iso(), "routine": f["routine"],
                   "severity": f["severity"], "title": f["title"], "where": f["where"],
                   "detail": f["detail"], "proposed_fix": f["fix"],
                   "touches_code": f["touches_code"], "key": key}
            if f.get("agent"):
                rec["agent"] = f["agent"]
            line = json.dumps(rec)
            os.makedirs(os.path.dirname(OVERFLOW), exist_ok=True)
            with open(OVERFLOW, "a") as fh:
                fh.write(line + "\n")
            ref = overflow_ref(line)
            who = f["routine"] + (" / " + f["agent"] if f.get("agent") else "")
            if len(mine) >= MAX_OPEN_PER_ROUTINE:
                print("REFUSED: %s already has %d open findings (cap %d)."
                      % (who, len(mine), MAX_OPEN_PER_ROUTINE), file=sys.stderr)
            else:
                # The filer is under its own cap; the routine as a whole is full.
                mine = lane
                print("REFUSED: the routine %s holds %d open findings, its ceiling (%d) whatever "
                      "the agent." % (f["routine"], len(lane), ROUTINE_CEILING), file=sys.stderr)
            oldest = sorted(mine, key=lambda r: r["ts"])[:3]
            print("Kept in %s as %s — nothing is lost, and the Defects card counts it as "
                  "refused and unread until someone sorts it." % (OVERFLOW, ref), file=sys.stderr)
            if not f.get("agent") and len(lane) < ROUTINE_CEILING:
                print("If you are an AI agent filing under a shared routine, file again with "
                      "--agent \"<your name>\": the cap then counts your own findings, not the "
                      "whole lane's.", file=sys.stderr)
            print("A reader files it with `findings.py overflow promote %s`. Close or merge "
                  "some of yours first. Oldest three:" % ref, file=sys.stderr)
            for r in oldest:
                print("  %s  %-8s %s" % (r["id"], r.get("severity", "?"), r["title"]),
                      file=sys.stderr)
            return 2, ref

    fid = next_id(f["routine"])
    rec = {
        "op": "add", "id": fid, "ts": iso(), "routine": f["routine"],
        "severity": f["severity"], "title": f["title"], "where": f["where"],
        "detail": f["detail"], "proposed_fix": f["fix"], "touches_code": f["touches_code"],
    }
    if f.get("agent"):
        rec["agent"] = f["agent"]
    # Rule 2: not the same defect, but the same file. Carried on the record so
    # the fixer sees the cluster in `list` instead of meeting six ids one at a
    # time and treating each as a small separate thing.
    neighbours = open_sharing_file(state, f["where"], exclude_id=fid)
    if neighbours:
        rec["same_file_as"] = neighbours
    append(rec)
    print(fid)
    if neighbours:
        print("NOTE: %d open finding(s) already name this file: %s"
              % (len(neighbours), ", ".join(neighbours)), file=sys.stderr)
    return 0, fid


def cmd_add(a):
    agent, note = resolve_agent(a.agent)
    if note:
        print("NOTE: " + note, file=sys.stderr)
    f = {"routine": a.routine, "title": a.title, "where": a.where, "detail": a.detail,
         "fix": a.fix, "severity": a.severity, "touches_code": a.touches_code, "agent": agent}
    rc, _ = file_finding(current_state(), f)
    return rc


def overflow_rows():
    """Everything the cap refused, read back off disk.

    THE FILE NOBODY READ (8 Oct 2026, finding 20261008-phase-2-790). The cap
    kept the queue from growing without bound by appending the refusals to
    findings-overflow.jsonl — and nothing in the rotation ever opened it. By
    8 Oct it held 189 lines, three of them added the day before, one of them a
    rent-check fault. A routine that files one is told "nothing is lost", which
    was true of the disk and false of the work.

    So `list` reads it. A backlog that is visible can be decided about; one in
    an unread file is written off by neglect while still reporting as filed.

    Each row carries `_ref`, a hash of its own line, so a reader can name it
    and the queue can record that it was read (14 Oct 2026)."""
    rows = []
    try:
        with open(OVERFLOW) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    row = json.loads(line)
                except ValueError:
                    # Loud, never silent: a half-written line must not make the
                    # rest of the backlog disappear from the count.
                    row = {"ts": "?", "routine": "?", "severity": "?",
                           "title": "UNREADABLE overflow line in %s" % OVERFLOW}
                if not isinstance(row, dict):
                    row = {"ts": "?", "routine": "?", "severity": "?",
                           "title": "UNREADABLE overflow line in %s" % OVERFLOW}
                row["_ref"] = overflow_ref(line)
                rows.append(row)
    except FileNotFoundError:
        return []
    except OSError as e:
        # `_error` marks the whole log unreadable: a reader must say "not read", never count
        # this placeholder as one refusal (review of PR #784).
        return [{"ts": "?", "routine": "?", "severity": "?", "_ref": "ofl-unreadable",
                 "_error": str(e)[:200], "title": "overflow log unreadable: %s" % e}]
    return rows


def overflow_ref(line):
    """A stable name for one overflow line: the same line always gets the same ref."""
    return "ofl-" + hashlib.sha1(line.strip().encode("utf-8")).hexdigest()[:10]


def refusal_key(row):
    """What makes two refused lines ONE refusal: the dedupe key `add` wrote on the line
    (the same routine, words and place refused twice is one problem), or the line itself."""
    return row.get("key") or row.get("_ref")


def refused_unread(rows):
    """(distinct refusals nobody has sorted, the read error or ''). Never a number for a
    log that could not be read."""
    err = next((r["_error"] for r in rows if r.get("_error")), "")
    if err:
        return None, err
    return len({refusal_key(r) for r in rows if not r.get("read")}), ""


def overflow_reads(ops=None):
    """ref -> the newest `overflow-read` op: who sorted that refused line, and how."""
    out = {}
    for rec in (read_all() if ops is None else ops):
        if rec.get("op") == "overflow-read" and rec.get("ref"):
            out[rec["ref"]] = rec
    return out


def overflow_state(ops=None):
    """Every refused row, each with `read` (its read op) or None while unread."""
    reads = overflow_reads(ops)
    rows = overflow_rows()
    for r in rows:
        r["read"] = reads.get(r.get("_ref"))
    return rows


def print_overflow(stream):
    rows = overflow_state()
    n, err = refused_unread(rows)
    if err:
        print("", file=stream)
        print("OVERFLOW: NOT READ — %s could not be opened (%s). Refusals may be waiting there."
              % (OVERFLOW, err), file=stream)
        return
    unread = [r for r in rows if not r.get("read")]
    if not unread:
        return
    oldest = min((r.get("ts") or "?") for r in unread)
    print("", file=stream)
    print("OVERFLOW: %d finding(s) the cap refused and nobody has sorted (%d lines), oldest %s, "
          "in %s (%d lines sorted already)." % (n, len(unread), oldest, OVERFLOW, len(rows) - len(unread)),
          file=stream)
    print("These are NOT in the queue above. `findings.py overflow list` names each one;"
          " oldest five:", file=stream)
    for r in sorted(unread, key=lambda r: (r.get("ts") or "?"))[:5]:
        print("  %s  %s  %-8s %-20s %s"
              % (r.get("_ref", "?"), (r.get("ts") or "?")[:10], r.get("severity", "?"),
                 r.get("routine", "?"), (r.get("title") or "")[:90]),
              file=stream)
    return


def cmd_list(a):
    state = current_state()
    rows = [r for r in state.values()
            if (a.status is None or r["status"] == a.status)
            and (a.routine is None or r["routine"] == a.routine)]
    if getattr(a, "stale", False):
        rows = [r for r in rows if is_stale_claim(r, a.stale_hours)]
    rows.sort(key=lambda r: (SEVERITIES.index(r.get("severity", "low"))
                             if r.get("severity") in SEVERITIES else 9, r["ts"]))
    if a.json:
        print(json.dumps(rows, indent=2))
        # stderr, so the JSON on stdout keeps its shape for every caller.
        print_overflow(sys.stderr)
        return 0
    if not rows:
        print("No findings match.")
        print_overflow(sys.stdout)
        return 0
    for r in rows:
        print("[%s] %-8s %-20s %s" % (r["id"], r.get("severity", "?"),
                                      r["routine"], r["title"]))
        if r.get("where"):
            print("         where: %s" % r["where"])
        if r.get("seen", 1) > 1:
            print("         SEEN %d TIMES (last %s) — recurring, not new"
                  % (r["seen"], r.get("last_seen") or "?"))
        if r.get("duplicate_root"):
            print("         REPEAT of %s — work that one, not this" % r["duplicate_root"])
        if r.get("duplicates"):
            print("         repeats merged in: %s" % ", ".join(r["duplicates"]))
        if r.get("touches_code") is False:
            print("         NOT CODE — a code fix cannot close this; it belongs on the task board")
        still_open = [i for i in (r.get("same_file_as") or [])
                      if (state.get(i) or {}).get("status") in OPEN_STATES]
        if still_open:
            print("         also open on this file: %s" % ", ".join(still_open))
        if r.get("proposed_fix"):
            print("         fix:   %s" % r["proposed_fix"])
        # A later sighting's fix text is the one a fixer must read, so it is
        # printed, never only stored. Newest last, each with its date. A merged
        # repeat says where it came from and what it saw.
        for rc in (r.get("recurrences") or []):
            if rc.get("from") and rc.get("note"):
                print("         from %s: %s" % (rc["from"], " ".join(rc["note"].split())[:300]))
            if rc.get("fix"):
                print("         fix (added %s%s): %s" % (rc.get("ts") or "?",
                                                         (", from " + rc["from"]) if rc.get("from") else "",
                                                         rc["fix"]))
    print_overflow(sys.stdout)
    return 0


def cmd_dupe(a):
    """Merge a repeat into the finding that survives it.

    Refused, never guessed: two findings that name DIFFERENT code files are two
    problems (one file holds many defects, so a shared file is not proof either;
    see rule 2 above). Only an open finding can be merged, only into one still
    open, and never into itself or round a loop."""
    state = current_state()
    for fid in (a.id, a.of):
        if fid not in state:
            print("ERROR: no finding %s" % fid, file=sys.stderr)
            return 1
    me, them = state[a.id], state[a.of]
    if a.id == a.of:
        print("REFUSED: a finding cannot repeat itself.", file=sys.stderr)
        return 2
    if me.get("status") != "open":
        print("REFUSED: %s is %s. Only an open finding can be merged; a claimed one is being "
              "worked and a pending one has a PR." % (a.id, me.get("status")), file=sys.stderr)
        return 2
    root = duplicate_root(state, a.of) if them.get("duplicate_of") else a.of
    if root is None or root == a.id:
        print("REFUSED: %s leads back to %s, so the merge would loop." % (a.of, a.id), file=sys.stderr)
        return 2
    if state[root].get("status") not in OPEN_STATES:
        print("REFUSED: %s is %s. A problem seen again after its finding closed is a recurrence: "
              "reopen that one (`reopen %s --force`) instead of merging into it."
              % (root, state[root].get("status"), root), file=sys.stderr)
        return 2
    pa, pb = code_paths(me.get("where")), code_paths(state[root].get("where"))
    if pa and pb and not (pa & pb) and not a.force:
        print("REFUSED: %s names %s and %s names %s. Different files are different problems; "
              "--force only if you have read both and they are one."
              % (a.id, ", ".join(sorted(pa)), root, ", ".join(sorted(pb))), file=sys.stderr)
        return 2
    append({"op": "dupe", "id": a.id, "of": root, "ts": iso(), "by": a.by, "note": a.note})
    print(json.dumps({"id": a.id, "duplicateOf": root}))
    return 0


def cmd_undupe(a):
    """Take a merge back: the finding stands on its own again, at its own status."""
    state = current_state()
    if a.id not in state:
        print("ERROR: no finding %s" % a.id, file=sys.stderr)
        return 1
    if not state[a.id].get("duplicate_of"):
        print("REFUSED: %s is not merged into anything." % a.id, file=sys.stderr)
        return 2
    append({"op": "undupe", "id": a.id, "ts": iso(), "by": a.by, "note": a.note})
    print(json.dumps({"id": a.id, "duplicateOf": None}))
    return 0


def cmd_retag(a):
    """Correct whether a finding needs code. Routing reads it: a code problem
    handed to an agent's task board is never fixed, and a matter left in the
    code queue is never handled."""
    state = current_state()
    if a.id not in state:
        print("ERROR: no finding %s" % a.id, file=sys.stderr)
        return 1
    if not (a.note or "").strip():
        print("REFUSED: retag needs --note saying why", file=sys.stderr)
        return 2
    want = bool(a.code)
    if bool(state[a.id].get("touches_code")) == want:
        print(json.dumps({"id": a.id, "touchesCode": want, "changed": False}))
        return 0
    append({"op": "retag", "id": a.id, "ts": iso(), "touches_code": want, "by": a.by, "note": a.note})
    print(json.dumps({"id": a.id, "touchesCode": want, "changed": True}))
    return 0


def cmd_claim(a):
    state = current_state()
    if a.id not in state:
        print("ERROR: no finding %s" % a.id, file=sys.stderr)
        return 1
    # Only an unclaimed finding may be claimed. Allowing a re-claim would let two
    # fixer runs both believe they own the same repair and write it twice.
    if state[a.id]["status"] != "open":
        print("ERROR: %s is already %s" % (a.id, state[a.id]["status"]), file=sys.stderr)
        return 1
    append({"op": "claim", "id": a.id, "ts": iso(), "by": a.by})
    print("claimed %s" % a.id)
    return 0


def cmd_reopen(a):
    """Put a finding back in the queue. Recovery for a run that died holding it.

    Never rewrites history: like every other op this appends, so the record of
    who claimed it and when survives the reopen.
    """
    state = current_state()
    now = datetime.utcnow()

    # An id AND --stale is a contradiction: one names a finding, the other says
    # "whatever is abandoned". Silently honouring one of them hides the mistake.
    if a.stale and a.id:
        print("ERROR: give a finding id OR --stale, not both", file=sys.stderr)
        return 1

    if a.stale:
        stale = [r for r in state.values() if is_stale_claim(r, a.stale_hours, now)]
        for r in stale:
            age = age_hours(r.get("claimed_at"), now)
            why = ("no readable timestamp" if age is None
                   else "%.1f hours" % age)
            if not a.dry_run:
                append({"op": "reopen", "id": r["id"], "ts": iso(),
                        "note": a.note or ("claim by %s went stale after %s"
                                           % (r.get("claimed_by", "?"), why))})
            print("reopened %s (claimed by %s, %s)%s"
                  % (r["id"], r.get("claimed_by", "?"), why,
                     " [dry-run]" if a.dry_run else ""))
        # Always a count, INCLUDING zero. A prose "No stale claims." reads fine
        # to a human but a routine cannot act on it, and it makes a genuinely
        # empty run indistinguishable from a query that returned nothing because
        # it was broken. Findings coming back means an earlier run died.
        print("reopened %d finding(s)" % len(stale))
        return 0

    if not a.id:
        print("ERROR: give a finding id, or --stale", file=sys.stderr)
        return 1
    if a.id not in state:
        print("ERROR: no finding %s" % a.id, file=sys.stderr)
        return 1
    if state[a.id]["status"] not in ("claimed",) and not a.force:
        # Reopening a CLOSED finding is a real thing to want (a fix that did not
        # hold) but it is not the accident this exists for, so it needs --force.
        print("ERROR: %s is %s, not claimed. Use --force to reopen anyway."
              % (a.id, state[a.id]["status"]), file=sys.stderr)
        return 1
    append({"op": "reopen", "id": a.id, "ts": iso(), "note": a.note})
    print("reopened %s" % a.id)
    return 0


# ---------------------------------------------------------------------------
# evidence on close
# ---------------------------------------------------------------------------
# Findings 20260820-agent-dispatch-262 and 20260820-queue-fixer-266.
#
# `close --outcome fixed` used to accept any words at all. Findings 201, 203,
# 204 and 237 were every one of them closed as "fixed" on days when
# `git log -- scripts/agent_email_format.py scripts/send-email.py` returned ZERO
# commits, and `grep -rn strip_carry_out_line` returned nothing. Six approved
# creditor emails then failed to send on three consecutive runs while the queue
# read clean. The defect was never in any individual fix. It was in the close
# path, which recorded an outcome and asked for no proof.
#
# So `fixed` now needs evidence, and the strongest kind is checked rather than
# believed: a commit SHA must EXIST and be an ANCESTOR OF origin/main. A SHA
# that is only on a branch is a fix sitting in an open PR, which is `pending`.
#
# Evidence that is not a SHA (an Airtable write, a live invariant, a config
# change on the Mac) is taken at its word — this is a discipline gate, not a
# lie detector — but it must be SAID, and it lands in the ledger where the next
# run can read it.

SHA_RE = re.compile(r"\b[0-9a-f]{7,40}\b")

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _git(*args):
    """(rc, stdout). Never raises: git missing is not proof of anything."""
    try:
        p = subprocess.run(["git", "-C", REPO] + list(args),
                           capture_output=True, text=True, timeout=20)
        return p.returncode, (p.stdout or "").strip()
    except Exception:
        return 127, ""


def landed_on_main(sha):
    """(verdict, detail). verdict is 'landed' | 'branch-only' | 'unknown'."""
    rc, _ = _git("cat-file", "-e", sha + "^{commit}")
    if rc == 127:
        return "unknown", "git unavailable"
    if rc != 0:
        return "branch-only", "commit %s does not exist in this repo" % sha
    _git("fetch", "origin", "main", "--quiet")
    # Only the remote counts. Local `main` is whatever the last session left
    # behind, and a commit sitting on it unpushed is exactly the "written but
    # not landed" case this gate exists to refuse. Fall back to local main only
    # when there is no remote to ask (a bare clone with no origin).
    has_remote, _ = _git("rev-parse", "--verify", "--quiet", "origin/main")
    refs = ("origin/main",) if has_remote == 0 else ("main",)
    for ref in refs:
        rc, _ = _git("merge-base", "--is-ancestor", sha, ref)
        if rc == 0:
            return "landed", "%s is an ancestor of %s" % (sha, ref)
    return "branch-only", ("%s exists but is not an ancestor of origin/main — "
                           "it is on a branch, so the fix has not landed" % sha)


def task_status(rec_id):
    """The Status of a record in the Tasks table: its value ('' when blank), or
    None when no task has that id. Listed with RECORD_ID() on the Tasks table,
    because a GET by record id ignores the table in its URL (CLAUDE.md), so it
    cannot prove the record is a TASK. Raises when Airtable cannot be read."""
    with open(PAT_FILE) as fh:
        pat = fh.read().strip()
    q = urllib.parse.urlencode([("filterByFormula", "RECORD_ID()='%s'" % rec_id),
                                ("fields[]", "Status"), ("pageSize", "1")])
    req = urllib.request.Request("https://api.airtable.com/v0/%s/%s?%s" % (AIRTABLE_BASE, TASKS_TABLE, q),
                                 headers={"Authorization": "Bearer " + pat})
    with urllib.request.urlopen(req, timeout=30) as r:
        recs = json.load(r).get("records") or []
    if not recs:
        return None
    return (recs[0].get("fields") or {}).get("Status") or ""


def check_task(task):
    """(ok, message) for closing a finding against TASK: it must be a real task
    on the board and still open, or the finding's problem is in nobody's hands."""
    task = (task or "").strip()
    if not TASK_ID_RE.match(task):
        return False, ("--outcome tasked needs --task <rec id> of the open task that now "
                       "carries this problem (got %r)" % task)
    try:
        status = task_status(task)
    except Exception as e:  # noqa: BLE001 — refused with the reason, never assumed fine
        return False, "could not read task %s from Airtable, so it is NOT CHECKED: %s" % (task, str(e)[:160])
    if status is None:
        return False, "%s is not in the Tasks table" % task
    if status == "Completed":
        return False, ("%s is Completed. A finding closes against a task that still carries "
                       "the work; if the work was done, close it rejected or fixed and say so." % task)
    return True, "task %s is open (Status %s)" % (task, status or "blank")


def check_evidence(outcome, evidence, note, pr):
    """(ok, message). The whole gate, pure, so the tests can reach it."""
    note = (note or "").strip()
    evidence = (evidence or "").strip()

    if outcome == TASKED:
        if not note:
            return False, "--outcome tasked needs --note saying what the task carries"
        return True, ""

    if outcome == "pending":
        if not str(pr or "").strip():
            return False, ("--outcome pending needs --pr <n>: a fix nobody can "
                           "find is not a fix. Use `findings.py land --pr <n>` "
                           "once it merges.")
        return True, ""

    if outcome in ("rejected", "deferred"):
        if not note:
            return False, "--outcome %s needs --note explaining why" % outcome
        return True, ""

    # outcome == "fixed"
    if not (evidence or SHA_RE.search(note)):
        return False, (
            "--outcome fixed needs --evidence. 'fixed' means LANDED on "
            "origin/main, so the evidence is normally the commit SHA. If the fix "
            "is in an open PR use --outcome pending --pr <n> instead. If it is "
            "not a code change at all (an Airtable write, a live invariant, a "
            "setting on the Mac), say so in --evidence and it is taken at its "
            "word."
        )

    for sha in SHA_RE.findall(evidence) + SHA_RE.findall(note):
        verdict, detail = landed_on_main(sha)
        if verdict == "landed":
            return True, "evidence verified: %s" % detail
        if verdict == "branch-only":
            return False, ("%s. Close it as --outcome pending --pr <n> until it "
                           "merges." % detail)
    # No SHA anywhere: non-code evidence, recorded and trusted.
    return True, "evidence recorded (not a commit SHA, taken at its word)"


def cmd_close(a):
    state = current_state()
    if a.id not in state:
        print("ERROR: no finding %s" % a.id, file=sys.stderr)
        return 1
    ok, msg = check_evidence(a.outcome, getattr(a, "evidence", ""), a.note,
                             getattr(a, "pr", ""))
    if not ok:
        print("REFUSED: %s" % msg, file=sys.stderr)
        return 2
    until = (getattr(a, "until", "") or "").strip()
    if until and (a.outcome != "deferred" or not DATE_RE.match(until)):
        print("REFUSED: --until takes a YYYY-MM-DD date and only goes with --outcome deferred "
              "(got %r with %s)" % (until, a.outcome), file=sys.stderr)
        return 2
    task = (getattr(a, "task", "") or "").strip()
    if a.outcome == TASKED:
        ok, tmsg = check_task(task)
        if not ok:
            print("REFUSED: %s" % tmsg, file=sys.stderr)
            return 2
        msg = tmsg
    elif task:
        print("REFUSED: --task only goes with --outcome tasked", file=sys.stderr)
        return 2
    rec = {"op": "close", "id": a.id, "ts": iso(),
           "outcome": a.outcome, "note": a.note, "pr": getattr(a, "pr", ""),
           "evidence": (getattr(a, "evidence", "") or "").strip()}
    if until:
        rec["until"] = until
    if task:
        rec["task"] = task
    append(rec)
    print("closed %s as %s%s" % (a.id, a.outcome, (" until %s" % until) if until else ""))
    if msg:
        print("  %s" % msg)
    if a.outcome == "pending":
        print("NOT counted as fixed until the PR merges — run "
              "`findings.py land --pr %s` then." % (getattr(a, "pr", "") or "<n>"),
              file=sys.stderr)
    return 0


def cmd_escalate(a):
    """Raise an open finding's severity so the fixer takes it first.

    WHY (Kevin, 7 Oct 2026): 19 robots sat on TOOL walls for up to 12 days while
    their fixes were medium findings nobody claimed. The Task Board Manager's
    clock calls this when a TOOL wall passes 3 days with its finding still
    unclaimed. Append-only like every other op; severity only ratchets up, so a
    second call on a finding already at that level writes nothing. A closed
    finding is refused: reopen it first, so a raise never hides a closure."""
    state = current_state()
    if a.id not in state:
        print("ERROR: no finding %s" % a.id, file=sys.stderr)
        return 1
    rec = state[a.id]
    if rec.get("status") == DUPLICATE and rec.get("duplicate_root") in state:
        # A wall's clock names the finding the wall cites. When that finding
        # was merged, the fix that clears the wall is the survivor's, so the
        # raise goes there (14 Oct 2026), never a refusal the clock reads as
        # "nothing to raise".
        print("NOTE: %s is a repeat of %s; raising %s." % (a.id, rec["duplicate_root"],
                                                           rec["duplicate_root"]), file=sys.stderr)
        a.id = rec["duplicate_root"]
        rec = state[a.id]
    if rec.get("status") not in OPEN_STATES:
        print("REFUSED: %s is %s, not open. Reopen it first if the fix is still needed."
              % (a.id, rec.get("status")), file=sys.stderr)
        return 2
    old = rec.get("severity")
    if old in SEVERITIES and SEVERITIES.index(old) <= SEVERITIES.index(a.severity):
        print(json.dumps({"id": a.id, "severity": old, "changed": False}))
        return 0
    append({"op": "escalate", "id": a.id, "ts": iso(), "severity": a.severity,
            "why": a.why, "by": a.by})
    print(json.dumps({"id": a.id, "severity": a.severity, "was": old, "changed": True}))
    return 0


def cmd_land(a):
    """A PR merged. Everything pending on it is now genuinely fixed."""
    state = current_state()
    hit = [r for r in state.values()
           if r.get("status") == "pending" and str(r.get("pr", "")) == str(a.pr)]
    if not hit:
        print("No pending findings cite PR #%s." % a.pr, file=sys.stderr)
        return 1
    for r in hit:
        append({"op": "land", "id": r["id"], "ts": iso(), "pr": str(a.pr)})
    print("landed %d finding(s) from PR #%s" % (len(hit), a.pr))
    return 0


def cmd_count(a):
    """The bare number MUST be the backlog, not the archive.

    29 Aug 2026, finding 20260829-queue-fixer-401. `count` with no flag
    returned every finding ever filed — 402 that day against a real backlog of
    213 — and every routine that quoted "the findings count" quoted the
    lifetime total. Nearly double. A number nobody can act on is worse than no
    number, because it gets acted on anyway.

    So: bare `count` is what is still owed (open + claimed + pending). The
    lifetime total is still available, it just has to be asked for by name.
    """
    state = current_state()
    if a.breakdown:
        # A merged repeat is counted once, as a repeat, whatever state it took
        # from its survivor: a survivor's fix is one fix, not one per repeat.
        own = [r for r in state.values() if not r.get("duplicate_root")]
        for st in OPEN_STATES + ["fixed", "rejected", "deferred", TASKED]:
            print("%-9s %d" % (st, sum(1 for r in own if r["status"] == st)))
        print("%-9s %d" % (DUPLICATE, len(state) - len(own)))
        print("%-9s %d" % ("BACKLOG", sum(1 for r in state.values()
                                          if r["status"] in OPEN_STATES)))
        print("%-9s %d" % ("TOTAL", len(state)))
        n, err = refused_unread(overflow_state())
        print("%-9s %s" % ("REFUSED", n if err == "" else "NOT READ (%s)" % err))
        return 0
    if a.status == "all":
        print(len(state))
    elif a.status:
        print(sum(1 for r in state.values() if r["status"] == a.status))
    else:
        print(sum(1 for r in state.values() if r["status"] in OPEN_STATES))
    return 0


def overflow_match(state, row):
    """(verdict, finding id) for one refused row: 'recurrence' of an open finding
    (or of the survivor it was merged into), 'closed' when it repeats a finding
    already closed, or 'new'. Mechanical rules only (the same ones `add` uses),
    because sort --apply writes what this decides."""
    tid, _ = known_match(state, row.get("routine") or "", row.get("title") or "", row.get("where") or "")
    if tid:
        return "recurrence", tid
    key = dedupe_key(row.get("routine"), row.get("title"), row.get("where"))
    for r in state.values():
        if r.get("status") in FINAL_STATES and not r.get("duplicate_root") \
                and dedupe_key(r.get("routine"), r.get("title"), r.get("where")) == key:
            return "closed", r["id"]
    return "new", None


def _mark_read(ref, outcome, into, by, note):
    append({"op": "overflow-read", "ref": ref, "ts": iso(), "outcome": outcome,
            "into": into or "", "by": by or "", "note": note or ""})


def _fold_into_finding(row, fid, by, why):
    """A refused row is evidence about an open finding: record it there, then mark it read."""
    append({"op": "recur", "id": fid, "ts": iso(), "severity": row.get("severity"),
            "note": "From the overflow log (%s, refused %s): %s %s" % (
                row.get("_ref"), (row.get("ts") or "?")[:10], row.get("title") or "", row.get("detail") or ""),
            "fix": row.get("proposed_fix") or ""})
    _mark_read(row["_ref"], "recurrence", fid, by, why)


def _overflow_row(ref):
    for r in overflow_state():
        if r.get("_ref") == ref:
            return r
    return None


def cmd_overflow(a):
    """Read the refusals: list them, sort them against the queue, promote one
    into the queue or dismiss it. Every read is a ledger line, so the Defects
    card's "refused, unread" count only falls when someone actually decided."""
    if a.action in ("list", "sort"):
        rows = overflow_state()
        unread = [r for r in rows if not r.get("read")]
        pick = rows if getattr(a, "all", False) else unread
        if a.action == "list":
            if a.json:
                print(json.dumps(pick, indent=2))
                return 0
            for r in sorted(pick, key=lambda r: r.get("ts") or "?"):
                print("%s  %s  %-8s %-20s %s%s" % (
                    r.get("_ref"), (r.get("ts") or "?")[:10], r.get("severity", "?"),
                    (r.get("routine") or "?") + ("/" + r["agent"] if r.get("agent") else ""),
                    (r.get("title") or "")[:100],
                    ("  [read: %s %s]" % (r["read"].get("outcome"), r["read"].get("into") or "")) if r.get("read") else ""))
            print("%d refused, %d unread" % (len(rows), len(unread)))
            return 0
        state = current_state()
        verdicts = {"recurrence": [], "closed": [], "new": []}
        for r in unread:
            v, fid = overflow_match(state, r)
            verdicts[v].append((r, fid))
        if a.out:
            with open(a.out, "w") as fh:
                for v in ("recurrence", "closed", "new"):
                    for r, fid in verdicts[v]:
                        fh.write(json.dumps({"verdict": v, "finding": fid, "ref": r.get("_ref"),
                                             "ts": r.get("ts"), "routine": r.get("routine"),
                                             "agent": r.get("agent"), "title": r.get("title")}) + "\n")
        if a.apply:
            for r, fid in verdicts["recurrence"]:
                _fold_into_finding(r, fid, a.by, "folded into the open finding it repeats")
            for r, fid in verdicts["closed"]:
                # Read, citing the closed finding it repeats (review of PR #784): left unread it
                # would count as a refusal nobody sorted, for ever.
                _mark_read(r["_ref"], "repeats-closed", fid, a.by,
                           "repeats %s, closed as %s" % (fid, state[fid].get("status")))
        print(json.dumps({"unread": len(unread), "recurrence": len(verdicts["recurrence"]),
                          "repeatsClosed": len(verdicts["closed"]), "new": len(verdicts["new"]),
                          "applied": bool(a.apply)}))
        return 0

    if not a.ref:
        print("ERROR: give the overflow ref (from `findings.py overflow list`)", file=sys.stderr)
        return 1
    row = _overflow_row(a.ref)
    if row is None:
        print("ERROR: no overflow line %s" % a.ref, file=sys.stderr)
        return 1
    if row.get("read"):
        print("REFUSED: %s was already sorted (%s %s)." % (a.ref, row["read"].get("outcome"),
                                                           row["read"].get("into") or ""), file=sys.stderr)
        return 2
    if a.action == "dismiss":
        if not (a.note or "").strip():
            print("REFUSED: dismiss needs --note saying why it is not worth a finding", file=sys.stderr)
            return 2
        _mark_read(a.ref, "dismissed", "", a.by, a.note)
        print("dismissed %s" % a.ref)
        return 0
    if a.action == "fold":
        # A reader's match, where the mechanical rules in `sort` cannot see one (the same
        # problem in other words). Into an open finding: recorded there as a recurrence. Into
        # a closed one: read, citing it. Into another refused line: read, pointing at it, and
        # that line stays unread until it is sorted itself.
        into = (a.into or "").strip()
        if not into:
            print("REFUSED: fold needs --into <finding id or ofl- ref>", file=sys.stderr)
            return 2
        if into.startswith("ofl-"):
            if into == a.ref or _overflow_row(into) is None:
                print("REFUSED: %s is not another refused line" % into, file=sys.stderr)
                return 2
            _mark_read(a.ref, "repeat-of-refusal", into, a.by, a.note or "the same problem as %s" % into)
            print(json.dumps({"ref": a.ref, "outcome": "repeat-of-refusal", "into": into}))
            return 0
        state = current_state()
        if into not in state:
            print("ERROR: no finding %s" % into, file=sys.stderr)
            return 1
        tid = live_target(state, state[into])
        if tid:
            _fold_into_finding(row, tid, a.by, a.note or "folded into the open finding it repeats")
            print(json.dumps({"ref": a.ref, "outcome": "recurrence", "into": tid}))
            return 0
        target, status = survivor_status(state, into)
        _mark_read(a.ref, "repeats-closed", target, a.by,
                   a.note or "repeats %s, closed as %s" % (target, status))
        print(json.dumps({"ref": a.ref, "outcome": "repeats-closed", "into": target, "status": status}))
        return 0
    # promote: a reader decided this one is worth the queue, so the cap that
    # refused it does not get a second say. The dedupe still does.
    f = {"routine": row.get("routine") or "overflow", "title": row.get("title") or "",
         "where": row.get("where") or "", "detail": row.get("detail") or "",
         "fix": row.get("proposed_fix") or "", "touches_code": bool(row.get("touches_code")),
         "severity": row.get("severity") if row.get("severity") in SEVERITIES else "medium",
         "agent": row.get("agent") or ""}
    rc, fid = file_finding(current_state(), f, cap=False)
    if rc != 0:
        return rc
    _mark_read(a.ref, "promoted", fid, a.by, a.note)
    return 0


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = p.add_subparsers(dest="cmd", required=True)

    sp = sub.add_parser("add")
    sp.add_argument("--routine", required=True)
    sp.add_argument("--title", required=True)
    sp.add_argument("--where", default="")
    sp.add_argument("--detail", default="")
    sp.add_argument("--fix", default="")
    sp.add_argument("--severity", default="medium", choices=SEVERITIES)
    sp.add_argument("--touches-code", action="store_true",
                    help="set when fixing this means editing a repo file")
    sp.add_argument("--agent", default=os.environ.get("FINDINGS_AGENT", ""),
                    help="the AI agent filing it, when the routine is shared: the cap "
                         "counts each agent's own open findings (default $FINDINGS_AGENT)")
    sp.set_defaults(fn=cmd_add)

    sp = sub.add_parser("dupe", help="merge a repeat into the finding that survives it")
    sp.add_argument("id")
    sp.add_argument("--of", required=True, help="the survivor's id")
    sp.add_argument("--note", default="")
    sp.add_argument("--by", default="")
    sp.add_argument("--force", action="store_true",
                    help="merge even though the two name different code files")
    sp.set_defaults(fn=cmd_dupe)

    sp = sub.add_parser("undupe", help="take a merge back")
    sp.add_argument("id")
    sp.add_argument("--note", default="")
    sp.add_argument("--by", default="")
    sp.set_defaults(fn=cmd_undupe)

    sp = sub.add_parser("retag", help="correct whether a finding needs code")
    sp.add_argument("id")
    g = sp.add_mutually_exclusive_group(required=True)
    g.add_argument("--code", action="store_true", help="fixing it means editing a repo file")
    g.add_argument("--not-code", action="store_true", help="no code change can close it")
    sp.add_argument("--note", default="")
    sp.add_argument("--by", default="")
    sp.set_defaults(fn=cmd_retag)

    sp = sub.add_parser("overflow", help="read what the cap refused")
    sp.add_argument("action", choices=["list", "sort", "promote", "dismiss", "fold"])
    sp.add_argument("ref", nargs="?")
    sp.add_argument("--into", default="", help="fold: the finding id (open or closed) or the ofl- ref it repeats")
    sp.add_argument("--all", action="store_true", help="list: include rows already sorted")
    sp.add_argument("--json", action="store_true")
    sp.add_argument("--apply", action="store_true",
                    help="sort: fold each repeat of an open finding into it (default: report only)")
    sp.add_argument("--out", default="", help="sort: write every verdict to this file")
    sp.add_argument("--note", default="")
    sp.add_argument("--by", default="")
    sp.set_defaults(fn=cmd_overflow)

    sp = sub.add_parser("list")
    sp.add_argument("--status")
    sp.add_argument("--routine")
    sp.add_argument("--json", action="store_true")
    sp.add_argument("--stale", action="store_true",
                    help="only claims older than --stale-hours")
    sp.add_argument("--stale-hours", "--lease-hours", type=float, dest="stale_hours", default=STALE_CLAIM_HOURS)
    sp.set_defaults(fn=cmd_list)

    sp = sub.add_parser("claim")
    sp.add_argument("id")
    sp.add_argument("--by", required=True)
    sp.set_defaults(fn=cmd_claim)

    sp = sub.add_parser("reopen", help="return a stuck finding to the queue")
    sp.add_argument("id", nargs="?")
    sp.add_argument("--stale", action="store_true",
                    help="reopen every claim older than --stale-hours")
    sp.add_argument("--stale-hours", "--lease-hours", type=float, dest="stale_hours", default=STALE_CLAIM_HOURS)
    sp.add_argument("--force", action="store_true",
                    help="reopen even a closed finding")
    sp.add_argument("--dry-run", action="store_true",
                    help="report what would reopen, write nothing")
    sp.add_argument("--note", default="")
    sp.set_defaults(fn=cmd_reopen)

    sp = sub.add_parser("close")
    sp.add_argument("id")
    sp.add_argument("--outcome", required=True,
                    choices=["fixed", "pending", "rejected", "deferred", TASKED],
                    help="'fixed' means LANDED on origin/main. A fix sitting in "
                         "an open PR is 'pending' — on 26 Aug 2026 four fixer "
                         "PRs were unmerged while 40 findings citing them read "
                         "as fixed. 'tasked' hands a problem no code fix can "
                         "close to the open task that now carries it.")
    sp.add_argument("--pr", default="", help="PR number carrying the fix")
    sp.add_argument("--task", default="", help="REQUIRED for --outcome tasked: the open task's rec id")
    sp.add_argument("--until", default="",
                    help="with --outcome deferred: the YYYY-MM-DD it comes back open by itself")
    sp.add_argument("--evidence", default="",
                    help="REQUIRED for --outcome fixed: the commit SHA that "
                         "landed it (checked against origin/main), or a plain "
                         "statement of the non-code proof")
    sp.add_argument("--note", default="")
    sp.set_defaults(fn=cmd_close)

    sp = sub.add_parser("escalate", help="raise an open finding's severity so the fixer takes it first")
    sp.add_argument("id")
    sp.add_argument("--severity", required=True, choices=SEVERITIES)
    sp.add_argument("--why", required=True)
    sp.add_argument("--by", default="")
    sp.set_defaults(fn=cmd_escalate)

    sp = sub.add_parser("land", help="a PR merged — flip its pending findings to fixed")
    sp.add_argument("--pr", required=True)
    sp.set_defaults(fn=cmd_land)

    sp = sub.add_parser(
        "count", help="bare = the BACKLOG (open+claimed+pending), not the archive")
    sp.add_argument("--status",
                    help="one status, or 'all' for every finding ever filed")
    sp.add_argument("--breakdown", action="store_true",
                    help="every status, labelled, plus BACKLOG and TOTAL")
    sp.set_defaults(fn=cmd_count)

    a = p.parse_args(argv)
    return a.fn(a)


if __name__ == "__main__":
    sys.exit(main())
