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
    findings.py close <id> --outcome fixed|rejected|deferred --note "..."
    findings.py count [--status open]
"""

import argparse
import json
import os
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
    append({
        "op": "add", "id": fid, "ts": iso(), "routine": a.routine,
        "severity": a.severity, "title": a.title, "where": a.where,
        "detail": a.detail, "proposed_fix": a.fix, "touches_code": a.touches_code,
    })
    print(fid)
    return 0


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
        return 0
    if not rows:
        print("No findings match.")
        return 0
    for r in rows:
        print("[%s] %-8s %-20s %s" % (r["id"], r.get("severity", "?"),
                                      r["routine"], r["title"]))
        if r.get("where"):
            print("         where: %s" % r["where"])
        if r.get("proposed_fix"):
            print("         fix:   %s" % r["proposed_fix"])
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


def cmd_close(a):
    state = current_state()
    if a.id not in state:
        print("ERROR: no finding %s" % a.id, file=sys.stderr)
        return 1
    append({"op": "close", "id": a.id, "ts": iso(),
            "outcome": a.outcome, "note": a.note, "pr": getattr(a, "pr", "")})
    print("closed %s as %s" % (a.id, a.outcome))
    if a.outcome == "pending":
        print("NOT counted as fixed until the PR merges — run "
              "`findings.py land --pr %s` then." % (getattr(a, "pr", "") or "<n>"),
              file=sys.stderr)
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
    state = current_state()
    if a.status:
        print(sum(1 for r in state.values() if r["status"] == a.status))
    else:
        print(len(state))
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
    sp.add_argument("--note", default="")
    sp.set_defaults(fn=cmd_close)

    sp = sub.add_parser("land", help="a PR merged — flip its pending findings to fixed")
    sp.add_argument("--pr", required=True)
    sp.set_defaults(fn=cmd_land)

    sp = sub.add_parser("count")
    sp.add_argument("--status")
    sp.set_defaults(fn=cmd_count)

    a = p.parse_args(argv)
    return a.fn(a)


if __name__ == "__main__":
    sys.exit(main())
