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
                    --detail "..." --fix "..." [--severity high]
    findings.py list [--status open] [--routine X] [--json]
    findings.py claim <id> --by queue-fixer
    findings.py reopen <id> [--force] | findings.py reopen --stale
    findings.py list --stale
    findings.py close <id> --outcome fixed --evidence <sha> --note "..."
    findings.py close <id> --outcome pending --pr <n> --note "..."
    findings.py close <id> --outcome rejected|deferred --note "..."
    findings.py escalate <id> --severity critical --why "..." [--by task-manager]
    findings.py count                 # the BACKLOG: open + claimed + pending
    findings.py count --status all    # every finding ever filed
    findings.py count --breakdown     # every status, labelled
"""

import argparse
import json
import os
import re
import subprocess
import sys
import time
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


def current_state():
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
            if rec.get("op") == "claim":
                state[fid]["status"] = "claimed"
                state[fid]["claimed_by"] = rec.get("by")
                state[fid]["claimed_at"] = rec.get("ts")
            elif rec.get("op") == "reopen":
                state[fid]["status"] = "open"
                state[fid].pop("claimed_by", None)
                state[fid].pop("claimed_at", None)
                state[fid]["reopen_note"] = rec.get("note")
            elif rec.get("op") == "recur":
                # Seen again. Evidence about an existing finding, never a new
                # one. Severity only ever ratchets UP: a defect that turns out
                # to be critical on its third sighting is critical.
                state[fid]["seen"] = state[fid].get("seen", 1) + 1
                state[fid]["last_seen"] = rec.get("ts")
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
                if rec.get("pr"):
                    state[fid]["pr"] = rec.get("pr")
    return state


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


def open_findings_for(state, routine):
    return [r for r in state.values()
            if r.get("routine") == routine and r.get("status") in OPEN_STATES]


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


def cmd_add(a):
    state = current_state()
    key = dedupe_key(a.routine, a.title, a.where)

    # 1. Already known and still open? Record the recurrence on the existing
    #    finding and return ITS id. A defect seen again is evidence about that
    #    defect, never a second defect.
    for r in state.values():
        if r.get("status") not in OPEN_STATES:
            continue
        if dedupe_key(r.get("routine"), r.get("title"), r.get("where")) != key:
            continue
        append({"op": "recur", "id": r["id"], "ts": iso(),
                "severity": a.severity, "note": a.detail})
        print(r["id"])
        print("RECURRENCE of %s (seen %d times) — no duplicate filed."
              % (r["id"], r.get("seen", 1) + 1), file=sys.stderr)
        return 0

    # 1b. Same FILE and same SYMBOL, whatever the routine or the wording. See
    #     the block above open_findings_for for why this is narrower than "same
    #     file" and why it has to be.
    for r in state.values():
        if r.get("status") not in OPEN_STATES:
            continue
        if not same_code_target(a.where, r.get("where")):
            continue
        append({"op": "recur", "id": r["id"], "ts": iso(),
                "severity": a.severity, "note": a.detail})
        print(r["id"])
        print("RECURRENCE of %s (seen %d times) — same code target (%s). "
              "No duplicate filed."
              % (r["id"], r.get("seen", 1) + 1,
                 ", ".join(sorted(code_paths(a.where) & code_paths(r.get("where"))))),
              file=sys.stderr)
        return 0

    # 2. Cap the routine's own open queue. Critical and high are never refused.
    if a.severity not in ALWAYS_ACCEPT:
        mine = open_findings_for(state, a.routine)
        if len(mine) >= MAX_OPEN_PER_ROUTINE:
            rec = {"op": "overflow", "ts": iso(), "routine": a.routine,
                   "severity": a.severity, "title": a.title, "where": a.where,
                   "detail": a.detail, "proposed_fix": a.fix,
                   "touches_code": a.touches_code, "key": key}
            os.makedirs(os.path.dirname(OVERFLOW), exist_ok=True)
            with open(OVERFLOW, "a") as f:
                f.write(json.dumps(rec) + "\n")
            oldest = sorted(mine, key=lambda r: r["ts"])[:3]
            print("REFUSED: %s already has %d open findings (cap %d)."
                  % (a.routine, len(mine), MAX_OPEN_PER_ROUTINE), file=sys.stderr)
            print("Kept in %s — nothing is lost." % OVERFLOW, file=sys.stderr)
            print("Close or merge some of yours first. Oldest three:", file=sys.stderr)
            for r in oldest:
                print("  %s  %-8s %s" % (r["id"], r.get("severity", "?"), r["title"]),
                      file=sys.stderr)
            return 2

    fid = next_id(a.routine)
    rec = {
        "op": "add", "id": fid, "ts": iso(), "routine": a.routine,
        "severity": a.severity, "title": a.title, "where": a.where,
        "detail": a.detail, "proposed_fix": a.fix, "touches_code": a.touches_code,
    }
    # Rule 2: not the same defect, but the same file. Carried on the record so
    # the fixer sees the cluster in `list` instead of meeting six ids one at a
    # time and treating each as a small separate thing.
    neighbours = open_sharing_file(state, a.where, exclude_id=fid)
    if neighbours:
        rec["same_file_as"] = neighbours
    append(rec)
    print(fid)
    if neighbours:
        print("NOTE: %d open finding(s) already name this file: %s"
              % (len(neighbours), ", ".join(neighbours)), file=sys.stderr)
    return 0


def overflow_rows():
    """Everything the cap refused, read back off disk.

    THE FILE NOBODY READ (8 Oct 2026, finding 20261008-phase-2-790). The cap
    kept the queue from growing without bound by appending the refusals to
    findings-overflow.jsonl — and nothing in the rotation ever opened it. By
    8 Oct it held 189 lines, three of them added the day before, one of them a
    rent-check fault. A routine that files one is told "nothing is lost", which
    was true of the disk and false of the work.

    So `list` reads it. A backlog that is visible can be decided about; one in
    an unread file is written off by neglect while still reporting as filed."""
    rows = []
    try:
        with open(OVERFLOW) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    rows.append(json.loads(line))
                except ValueError:
                    # Loud, never silent: a half-written line must not make the
                    # rest of the backlog disappear from the count.
                    rows.append({"ts": "?", "routine": "?", "severity": "?",
                                 "title": "UNREADABLE overflow line in %s" % OVERFLOW})
    except FileNotFoundError:
        return []
    except OSError as e:
        return [{"ts": "?", "routine": "?", "severity": "?",
                 "title": "overflow log unreadable: %s" % e}]
    return rows


def print_overflow(stream):
    rows = overflow_rows()
    if not rows:
        return
    oldest = min((r.get("ts") or "?") for r in rows)
    print("", file=stream)
    print("OVERFLOW: %d finding(s) the cap refused, oldest %s, in %s."
          % (len(rows), oldest, OVERFLOW), file=stream)
    print("These are NOT in the queue above and no routine has ever read them."
          " Oldest five:", file=stream)
    for r in sorted(rows, key=lambda r: (r.get("ts") or "?"))[:5]:
        print("  %s  %-8s %-20s %s"
              % ((r.get("ts") or "?")[:10], r.get("severity", "?"),
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
        still_open = [i for i in (r.get("same_file_as") or [])
                      if (state.get(i) or {}).get("status") in OPEN_STATES]
        if still_open:
            print("         also open on this file: %s" % ", ".join(still_open))
        if r.get("proposed_fix"):
            print("         fix:   %s" % r["proposed_fix"])
    print_overflow(sys.stdout)
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


def check_evidence(outcome, evidence, note, pr):
    """(ok, message). The whole gate, pure, so the tests can reach it."""
    note = (note or "").strip()
    evidence = (evidence or "").strip()

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
    append({"op": "close", "id": a.id, "ts": iso(),
            "outcome": a.outcome, "note": a.note, "pr": getattr(a, "pr", ""),
            "evidence": (getattr(a, "evidence", "") or "").strip()})
    print("closed %s as %s" % (a.id, a.outcome))
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
        for st in OPEN_STATES + ["fixed", "rejected", "deferred"]:
            print("%-9s %d" % (st, sum(1 for r in state.values()
                                       if r["status"] == st)))
        print("%-9s %d" % ("BACKLOG", sum(1 for r in state.values()
                                          if r["status"] in OPEN_STATES)))
        print("%-9s %d" % ("TOTAL", len(state)))
        return 0
    if a.status == "all":
        print(len(state))
    elif a.status:
        print(sum(1 for r in state.values() if r["status"] == a.status))
    else:
        print(sum(1 for r in state.values() if r["status"] in OPEN_STATES))
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
    sp.set_defaults(fn=cmd_add)

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
                    choices=["fixed", "pending", "rejected", "deferred"],
                    help="'fixed' means LANDED on origin/main. A fix sitting in "
                         "an open PR is 'pending' — on 26 Aug 2026 four fixer "
                         "PRs were unmerged while 40 findings citing them read "
                         "as fixed.")
    sp.add_argument("--pr", default="", help="PR number carrying the fix")
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
