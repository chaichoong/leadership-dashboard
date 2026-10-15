#!/usr/bin/env python3
"""Is the AI team healthy? One verdict for the Leadership Dashboard (Kevin, 15 Oct 2026).

WHY THIS EXISTS
---------------
Kevin, approving it on 15 Oct 2026: "I just need to see that it's working, and/or if we've
got loads of issues, that the issues are reducing and it's going in the right direction. If I
can't understand them, I can't use them." The AI Team section showed four cards (Agent Work,
Defects, Bottleneck, Fix of a Fix) whose numbers were true and that he could not read as an
answer. His questions were: no bottlenecks; everything's moving; nothing's getting missed;
emails are getting cleared; responses are getting written; the agents have control of their
work; every agent is working; no one is broken; no bugs or errors.

WHAT IT IS
----------
Fourteen lines, each a question in his words with a colour, a short answer, a number, a
one-sentence rule and a trend against last week, in three groups, with one overall verdict.
scripts/estate-status.py calls verdict_row() on its ten-minute pass and writes it as the
Estate Status row `ai-team-verdict`. The page (js/dashboard.js) only draws it.

THE RULES THAT MATTER MORE THAN THE THRESHOLDS
-----------------------------------------------
- A source that cannot be read, is missing, or is older than its own cadence makes its line
  GREY, "Can't tell: <why>". Never green. The overall verdict names every grey line.
- Each judge is a pure function of what was read, so tests drive the rule itself.
- A line never counts what another line counts where the brief says so: "Everything's moving"
  takes every walled task out before it counts, because walls are "No bottlenecks".
- The trend history (one number per line per London day, 30 days) lives INSIDE the row's
  payload, mirrored to a local file so one failed Airtable read cannot wipe a month of it.

Usage:
  python3 scripts/ai_team_health.py dry-run [--out FILE]   the 14 lines and their evidence,
                                                          read-only (FILE: the row, outside the repo)
  python3 scripts/ai_team_health.py selftest
Auth: ~/.config/od/airtable_pat (never printed), through estate-status.py's own request.
"""
import glob
import importlib.util
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

HERE = os.path.dirname(os.path.abspath(__file__))
LONDON = ZoneInfo("Europe/London")
LOGS = os.path.expanduser("~/knowledge-os/logs")

KEY = "ai-team-verdict"
LABEL = "Is the AI team healthy?"
HISTORY_DAYS = 30
TREND_DAYS = 7
HISTORY_MIRROR = os.path.join(LOGS, "ai-team-verdict-history.json")
ITEMS_MAX = 20

# Where each source lives, and how old it may be before its line says "Can't tell".
TRIAGE_DIR = os.path.join(LOGS, "inbound-triage")
TRIAGE_SCAN_MAX_HOURS = 18          # slots at 09:00, 13:00 and 17:00: the longest gap is 16 hours
TRIAGE_SLOT_GRACE_MIN = 30          # a slot writes its record within seconds of starting
TRIAGE_DEFAULT_RUN_MIN = 150        # job-schedule.json's maxRuntimeMinutes for the slot, when it is not set
TRIAGE_FINISH_GRACE_MIN = 15        # past its run limit plus this, a run with no end line did not finish
BLOCKERS_FILE = os.path.join(LOGS, "handback-poll", "scratch", "blockers.json")
BLOCKERS_MAX_MIN = 120              # the sweep runs every 30 minutes with the hand-back poll
DISPATCH_QUEUE = os.path.join(LOGS, "handback-poll", "scratch", "queue.json")
DISPATCH_QUEUE_MAX_MIN = 120        # written every 30 minutes (loop-health.py's own limit)
DISPATCH_DIR = os.path.join(LOGS, "agent-dispatch")
INVARIANTS_LOG = os.path.join(LOGS, "data-invariants.last.log")
INVARIANTS_MAX_HOURS = 26           # a daily 06:40 job
APPROVED_CARRY_HOURS = 24
AGENT_IDLE_HOURS = 24
DECIDED_DAYS = 14
INBOUND_WAIT_WORKING_DAYS = 1

GROUPS = (
    ("flow", "Is work flowing?"),
    ("broken", "Is anything broken?"),
    ("keep", "Can it keep going?"),
)

# Kevin's fourteen questions, in his order. `better` says which way the number should move.
LINES = (
    {"key": "emails", "group": "flow", "question": "Emails are getting cleared", "better": "lower", "unit": "",
     "rule": "Green means no email older than 2 days is left in the inbox after the last sort; "
             "amber is 1 to 5; red is more than 5, or the last sort did not run."},
    {"key": "responses", "group": "flow", "question": "Responses are getting written", "better": "lower", "unit": "",
     "rule": "Green means every email task gets a draft within 1 working day; amber is 1 to 3 "
             "waiting longer; red is more than 3."},
    {"key": "moving", "group": "flow", "question": "Everything's moving", "better": "lower", "unit": "%",
     "rule": "Green means 10% or fewer of the live tasks are stuck with nothing blocking them; "
             "amber is up to 25%; red is more. Blocked tasks are counted under No bottlenecks."},
    {"key": "bottlenecks", "group": "flow", "question": "No bottlenecks", "better": "lower", "unit": "",
     "rule": "Green means no blocked task has waited past its limit (a sign-in 1 day, a code fix or "
             "your step 3 days); amber is 1 to 3; red is more than 3."},
    {"key": "carried", "group": "flow", "question": "Approved work gets carried out", "better": "lower", "unit": "",
     "rule": "Green means every job you approved was done within 24 hours; amber is 1 or 2 still "
             "waiting; red is more than 2."},
    {"key": "agents", "group": "broken", "question": "Every agent is working", "better": "lower", "unit": "",
     "rule": "Green means every agent that has had live work for a day did something in the last "
             "24 hours; amber is 1 idle agent; red is 2 or more."},
    {"key": "jobs", "group": "broken", "question": "No job is broken", "better": "lower", "unit": "",
     "rule": "Green means no scheduled job failed its last run; amber is 1 or 2; red is 3 or more."},
    {"key": "bugs", "group": "broken", "question": "No bugs or errors", "better": "lower", "unit": "",
     "rule": "Green means code problems are fixed as fast as they come in and no more are open than "
             "a week ago; amber means no more are open but more came in than were fixed; red means "
             "more are open than a week ago."},
    {"key": "data", "group": "broken", "question": "The data is accurate", "better": "lower", "unit": "",
     "rule": "Green means the daily data check passed; red means it found wrong data; grey means it "
             "has not run in 26 hours."},
    {"key": "missed", "group": "broken", "question": "Nothing's getting missed", "better": "lower", "unit": "",
     "rule": "Green means in the last 24 hours no task was left with no card, no job gave up or missed "
             "its time, and no old email was left undecided; amber is 1; red is 2 or more."},
    {"key": "ontop", "group": "keep", "question": "Agents are on top of their work", "better": "higher", "unit": "%",
     "rule": "Green means agents finished at least as many tasks as they were given in the last 7 "
             "days; amber is at least 80%; red is less."},
    {"key": "queue", "group": "keep", "question": "Your queue is under control", "better": "lower", "unit": "",
     "rule": "Green means 10 or fewer cards wait for you and none has waited over 2 days; amber is up "
             "to 25 cards and 5 days; red is more."},
    {"key": "firsttime", "group": "keep", "question": "Drafts are right first time", "better": "higher", "unit": "%",
     "rule": "Green means you approved 85% or more of the agents' drafts without changes in the last "
             "14 days; amber is 70% to 85%; red is under 70%."},
    {"key": "allowance", "group": "keep", "question": "Enough allowance to finish the week", "better": "lower",
     "unit": "h",
     "rule": "Green means the robots were not paused for the Claude limit this week; amber means they "
             "were paused and are running again; red means they are paused now."},
)
LINE_BY_KEY = {d["key"]: d for d in LINES}
COLOURS = ("green", "amber", "red", "grey")


# ─── small helpers ────────────────────────────────────────────────────
def plural(n, one, many=None):
    return "%d %s" % (n, one if n == 1 else (many or one + "s"))


def _aware(value):
    """An ISO time as an aware UTC datetime, or None. A time with no zone is read as UTC, the
    way estate-status.py's _within reads the findings log."""
    if not value:
        return None
    try:
        t = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return t if t.tzinfo else t.replace(tzinfo=timezone.utc)


def london_day(now):
    return now.astimezone(LONDON).date().isoformat()


def when_text(t):
    if not t:
        return "never"
    return t.astimezone(LONDON).strftime("%a %d %b %H:%M")


def item(name, rid="", note=""):
    out = {"name": str(name or "(untitled)")[:120]}
    if rid:
        out["id"] = str(rid)
    if note:
        out["note"] = str(note)[:120]
    return out


def line(key, colour, answer, number, items=(), extra=(), source="", why=None, partial=False):
    """`partial`: the number came from a source read only in part (a floor, review of PR #790).
    It is shown, never written to the history and never given a trend direction."""
    d = LINE_BY_KEY[key]
    assert colour in COLOURS, colour
    out = {"key": key, "n": [x["key"] for x in LINES].index(key) + 1, "group": d["group"],
           "question": d["question"], "colour": colour, "answer": answer, "number": number,
           "unit": d["unit"], "better": d["better"], "rule": d["rule"],
           "items": list(items)[:ITEMS_MAX], "itemsTotal": len(list(items)),
           "extra": [[str(a), str(b)] for a, b in extra], "source": source}
    if why:
        out["why"] = why
    if partial:
        out["partial"] = True
    return out


def grey(key, why, source="", extra=()):
    """The one way a line says it cannot be read. Never green, never a zero."""
    return line(key, "grey", "Can't tell: " + why, None, extra=extra, source=source, why=why)


def by_count(n, amber_max):
    """Green at 0, amber from 1 to amber_max, red above it."""
    if n <= 0:
        return "green"
    return "amber" if n <= amber_max else "red"


def working_days_between(start, end):
    """Days of Monday-to-Friday London time between two instants (weekends do not count)."""
    if not start or not end or end <= start:
        return 0.0
    s, e = start.astimezone(LONDON), end.astimezone(LONDON)
    total = 0.0
    day = s.replace(hour=0, minute=0, second=0, microsecond=0)
    while day < e:
        nxt = (day + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
        if day.weekday() < 5:
            lo, hi = max(day, s), min(nxt, e)
            if hi > lo:
                total += (hi - lo).total_seconds()
        day = nxt
    return total / 86400.0


def _load(name, file):
    spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, file))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _read_json(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


# ─── the judges: pure functions of what was read ──────────────────────
# How a known-bad inbox run reads (line 1). Each is red: the inbox was not cleared by it.
SLOT_BAD = {"missed": "The %s inbox run did not start", "failed": "The %s inbox run failed",
            "unfinished": "The %s inbox run did not finish", "errored": "The %s inbox run ended with an error"}
def judge_emails(f, now):
    """f: {"left", "truncated", "scannedAt", "slot": {"name", "date", "state", "reason"}, "items"}
    or {"error"}. A missed or failed slot is red whatever the count, because it is known."""
    src = "Inbox sort: its slot record and its inbox count after the last sort"
    if f.get("error"):
        return grey("emails", f["error"], src)
    slot = f.get("slot") or {}
    if slot.get("state") in SLOT_BAD:
        # The count on file is an earlier run's: it is shown in the detail, never as this line's
        # number, so the history never keeps it as today's (review of PR #790).
        answer = SLOT_BAD[slot["state"]] % (slot.get("name") or "last")
        return line("emails", "red", answer, None, f.get("items") or (),
                    [["Last inbox run", "%s %s: %s" % (slot.get("date", ""), slot.get("name", ""), slot.get("reason") or answer)],
                     ["Old mail counted by an earlier run", f.get("left") if f.get("left") is not None else "not known"]], src)
    scanned = _aware(f.get("scannedAt"))
    if not scanned or (now - scanned) > timedelta(hours=TRIAGE_SCAN_MAX_HOURS):
        return grey("emails", "the inbox was last sorted %s" % when_text(scanned), src)
    n = f.get("left")
    if not isinstance(n, int):
        return grey("emails", "the last sort recorded no count of old mail", src)
    floor = "at least " if f.get("truncated") else ""
    if n == 0 and not f.get("truncated"):
        colour, answer = "green", "Inbox clear"
    else:
        # A cut-off listing makes the count a floor: never green on a floor of 0.
        colour = by_count(max(n, 1), 5)
        answer = "%s%s over 2 days old" % (floor, plural(n, "email"))
    extra = [["Last sort", when_text(scanned)]]
    if f.get("truncated"):
        extra.append(["Note", "the inbox list was cut off, so this is a floor"])
    return line("emails", colour, answer, n, f.get("items") or (), extra, src)


def judge_responses(f):
    src = "Open email tasks owned by an agent, from the task board"
    if f.get("error"):
        return grey("responses", f["error"], src)
    items = f.get("items") or []
    n = len(items)
    colour = by_count(n, 3)
    answer = "Every email task has a draft" if n == 0 else "%s waiting for a draft" % plural(n, "email task")
    return line("responses", colour, answer, n, items, [["Waiting over 1 working day", n]], src)


def judge_moving(f):
    """stuck: ids not moving with no wall on them; live: the live count. The walled ones are
    removed before this sees them, so a wall is never counted here and under No bottlenecks."""
    src = "The list of agent tasks that should have moved and did not, minus every blocked task, against live agent work"
    if f.get("error"):
        return grey("moving", f["error"], src)
    stuck, live = f.get("stuck") or [], f.get("live")
    if not isinstance(live, int):
        return grey("moving", "the live work count could not be read", src)
    n = len(stuck)
    pct = round(100.0 * n / live) if live else 0
    colour = "green" if pct <= 10 else "amber" if pct <= 25 else "red"
    extra = [[k, v] for k, v in (f.get("split") or [])] + [
        ["Stuck, nothing blocking", n], ["Stuck but blocked (counted under No bottlenecks)", f.get("walledOut", 0)]]
    return line("moving", colour, "%d of %d live tasks stuck (%d%%)" % (n, live, pct), pct, stuck, extra, src)


def judge_bottlenecks(f, now):
    src = "The half-hourly blocked-task sweep"
    if f.get("error"):
        return grey("bottlenecks", f["error"], src)
    past = f.get("past") or []
    n = len(past)
    colour = by_count(n, 3)
    answer = "No blocked task past its limit" if n == 0 else "%s past %s limit" % (
        plural(n, "blocked task"), "its" if n == 1 else "their")
    extra = [[k, v] for k, v in (f.get("byKind") or [])] + [["Blocked in all", f.get("total", 0)]]
    return line("bottlenecks", colour, answer, n, past, extra, src)


def judge_carried(f):
    src = "The dispatcher's own list of approved work still to carry out"
    if f.get("error"):
        return grey("carried", f["error"], src)
    items = f.get("items") or []
    n = len(items)
    colour = by_count(n, 2)
    answer = "Every approved job done" if n == 0 else "%s not done after 24h" % plural(n, "approved job")
    return line("carried", colour, answer, n, items, [["Approved, waiting under 24h", f.get("young", 0)]], src)


def judge_agents(f):
    src = "Each agent's live tasks, and its actions in the last 24 hours (run reports, completions, notes)"
    if f.get("error"):
        return grey("agents", f["error"], src)
    agents = f.get("agents") or []
    idle = [a for a in agents if not a.get("acted")]
    n, total = len(idle), len(agents)
    colour = by_count(n, 1)
    if not total:
        answer = "No agent has live work"
    elif n:
        answer = "%d idle, %d of %d worked today" % (n, total - n, total)
    else:
        answer = "All %d worked today" % total
    items = [item(a["name"], a.get("id", ""), "%s live, nothing done in 24h%s" % (
        plural(a.get("live", 0), "task"), (": " + "; ".join(str(t)[:50] for t in a["tasks"][:2])) if a.get("tasks") else ""))
        for a in idle]
    extra = [[a["name"], "%d live, %s" % (a.get("live", 0), "worked" if a.get("acted") else "idle")]
             for a in agents][:ITEMS_MAX]
    return line("agents", colour, answer, n, items, extra, src)


def judge_jobs(f):
    src = "The Estate Status board (every scheduled job's last run)"
    failed = f.get("failed") or []
    n = len(failed)
    if f.get("error") and n < 3:
        return grey("jobs", f["error"], src)
    colour = by_count(n, 2)
    if n == 0:
        answer = "Every job ran cleanly"
    else:
        answer = "%s failed or %s blocked" % (plural(n, "job"), "was" if n == 1 else "were")
    extra = [["Counted", "a last run that failed, or was blocked (a sign-in, the network, Drive, the lock, too long)"],
             ["Counted elsewhere", "the blocked-tasks report under No bottlenecks; Claude limit stops under Enough allowance"]]
    if f.get("error"):
        extra.append(["Could not read", f["error"]])
    return line("jobs", colour, answer, n, failed, extra, src, partial=bool(f.get("error")))


def judge_bugs(f):
    """Open CODE problems now against a week ago, and filed against fixed in 7 days."""
    src = "The list of problems the robots and daily checks found, now and as it stood 7 days ago"
    if f.get("error"):
        return grey("bugs", f["error"], src)
    code, before = f.get("code"), f.get("codeWeekAgo")
    if not isinstance(code, int):
        return grey("bugs", "the defect queue carries no code count", src)
    if not isinstance(before, int):
        return grey("bugs", "the queue as it stood a week ago could not be read%s" % (
            ": " + f["weekAgoError"] if f.get("weekAgoError") else ""), src)
    filed, fixed = int(f.get("filed7d") or 0), int(f.get("fixed7d") or 0)
    if code > before:
        colour, answer = "red", "%d code problems open, up from %d" % (code, before)
    else:
        colour = "green" if fixed >= filed else "amber"
        answer = ("%d code problems open, down from %d" % (code, before)) if code < before \
            else "%d code problems open, no rise" % code
    rw = f.get("rework") or {}
    extra = [["Code problems open", code], ["A week ago, by today's rules", before],
             ["All open problems", f.get("open", "not known")], ["Not code (moved to tasks)", f.get("notCode", "not known")],
             ["Filed in 7 days", filed], ["Fixed in 7 days", fixed]]
    if f.get("refusedUnread") is not None:
        extra.append(["Turned away because the list was full, not yet read", f["refusedUnread"]])
    if rw.get("pct") is not None:
        extra.append(["Fix of a fix (%s days)" % rw.get("days", 14), "%s%% (%s of %s fixes, baseline %s%%)" % (
            rw["pct"], rw.get("fixOfFix"), rw.get("fixes"), rw.get("baselinePct"))])
    elif rw:
        extra.append(["Fix of a fix", "no fixes in %s days" % rw.get("days", 14)])
    return line("bugs", colour, answer, code, (), extra, src)


def judge_data(f, now):
    src = "The daily data check's own log"
    if f.get("error"):
        return grey("data", f["error"], src)
    ran = _aware(f.get("ranAt"))
    if not ran or (now - ran) > timedelta(hours=INVARIANTS_MAX_HOURS):
        return grey("data", "the data check has not run since %s" % when_text(ran), src)
    broken = f.get("broken") or []
    if f.get("result") == "pass" and not broken:
        return line("data", "green", "Data check passed", 0, (), [["Ran", when_text(ran)], ["Checks", f.get("checks", "not known")]], src)
    if f.get("result") not in ("pass", "broken"):
        return grey("data", "the data check's log has no result line", src)
    n = len(broken)
    answer = "%s found wrong data" % plural(n, "data check") if n else "The data check failed"
    return line("data", "red", answer, n, [item(b) for b in broken], [["Ran", when_text(ran)]], src)


def judge_missed(f):
    """Three kinds of miss, counted together. A part that cannot be read keeps the line grey
    unless the parts that were read already make it red."""
    src = "The agents' run reports, the job queue's log and the inbox sort, last 24 hours"
    parks, gave, undecided = f.get("parks") or [], f.get("gaveUp") or [], f.get("undecided") or []
    errors = f.get("errors") or []
    n = len(parks) + len(gave) + len(undecided)
    if errors and n < 2:
        return grey("missed", "; ".join(errors), src)
    colour = by_count(n, 1)
    answer = "Nothing missed" if n == 0 else "%s missed" % plural(n, "thing")
    extra = [["Left with no card and no door", len(parks)], ["Jobs that gave up or did not run", len(gave)],
             ["Old emails nobody decided", len(undecided)]]
    for it in f.get("late") or []:
        extra.append(["Ran late (not counted)", "%s: %s" % (it["name"], it.get("note", ""))])
    for e in errors:
        extra.append(["Could not read", e])
    return line("missed", colour, answer, n, list(parks) + list(gave) + list(undecided), extra, src,
                partial=bool(errors))


def judge_ontop(f):
    src = "Agent tasks created against agent tasks done, last 7 days, from the task board"
    if f.get("error"):
        return grey("ontop", f["error"], src)
    new, done = f.get("in"), f.get("done")
    if not isinstance(new, int) or not isinstance(done, int):
        return grey("ontop", "the 7-day counts could not be read", src)
    pct = round(100.0 * done / new) if new else 100
    colour = "green" if done >= new else "amber" if done >= 0.8 * new else "red"
    return line("ontop", colour, "%d%% done: %d done, %d new" % (pct, done, new), pct, (),
                [["New agent tasks", new], ["Done", done], ["Done as a share of new", "%d%%" % pct]], src)


def judge_queue(f):
    src = "Cards at Approval and not put off to a later date, from the task board"
    if f.get("error"):
        return grey("queue", f["error"], src)
    cards = f.get("cards") or []
    n = len(cards)
    oldest = max((c["days"] for c in cards), default=0.0)
    if n <= 10 and oldest <= 2:
        colour = "green"
    elif n <= 25 and oldest <= 5:
        colour = "amber"
    else:
        colour = "red"
    answer = "No cards waiting" if n == 0 else "%s, oldest %s" % (
        plural(n, "card"), plural(int(oldest), "day") if oldest >= 1 else "under a day")
    items = [item(c["name"], c.get("id", ""), "%.1f days%s" % (c["days"], "" if c.get("dated") else
                                                              " (no send stamp: counted from when it was made)"))
             for c in sorted(cards, key=lambda c: -c["days"])]
    extra = [["Waiting", n], ["Oldest", "%.1f days" % oldest]]
    if f.get("undated"):
        extra.append(["Counted from when the card was made", f["undated"]])
    return line("queue", colour, answer, n, items, extra, src)


def judge_firsttime(f):
    src = "Your verdicts on agent drafts, last 14 days (form cards left out)"
    if f.get("error"):
        return grey("firsttime", f["error"], src)
    total = int(f.get("total") or 0)
    if not total:
        return grey("firsttime", "no verdicts in the last 14 days", src)
    as_is = int(f.get("asIs") or 0)
    pct = round(100.0 * as_is / total)
    colour = "green" if pct >= 85 else "amber" if pct >= 70 else "red"
    extra = [["Approved as-is", as_is], ["Approved with minor edits", f.get("minor", 0)],
             ["Changes requested", f.get("changes", 0)], ["Rejected", f.get("rejected", 0)]]
    if f.get("other"):
        extra.append(["Other verdicts", f["other"]])
    extra.append(["All verdicts", total])
    return line("firsttime", colour, "%d%% approved without changes" % pct, pct, (), extra, src)


def judge_allowance(f, now):
    src = "The Claude allowance guard and every job's run log, last 7 days"
    if f.get("error"):
        return grey("allowance", f["error"], src)
    hours = round(float(f.get("hours7d") or 0), 1)
    if f.get("pausedNow"):
        until = _aware(f.get("pausedUntil"))
        return line("allowance", "red", "Paused now until %s" % (until.astimezone(LONDON).strftime("%a %H:%M") if until else "unknown"),
                    hours, f.get("items") or (), [["Paused this week", "%.1f hours" % hours]], src)
    if hours > 0 or f.get("items") or f.get("hits"):
        answer = "Paused %.1f hours this week, running again" % hours if hours > 0 else "Paused this week, running again"
        return line("allowance", "amber", answer, hours, f.get("items") or (), [["Paused this week", "%.1f hours" % hours]], src)
    last = _aware(f.get("lastOutage"))
    return line("allowance", "green", "No pause this week", 0.0, (),
                [["Last pause the guard recorded", when_text(last) if last else "none recorded"],
                 ["Also read", "every job's run log for the Claude limit line, last 7 days"]], src)


# ─── trend, history and the verdicts ──────────────────────────────────
def merge_history(*histories):
    """One history from several copies (the row's and the local mirror's); a day both hold takes
    the copy with more lines in it, so a partial day never replaces a full one."""
    out = {}
    for h in histories:
        if not isinstance(h, dict):
            continue
        for day, snap in h.items():
            if not re.match(r"^\d{4}-\d{2}-\d{2}$", str(day)) or not isinstance(snap, dict):
                continue
            if day not in out or len(snap) >= len(out[day]):
                out[day] = dict(snap)
    return out


def apply_history(lines, history, now):
    """Merge today's numbers into today's snapshot line by line (the last real number for each
    line wins, so a later grey run never wipes the day: review of PR #790), keep 30 days, and give
    each line a trend against the snapshot 7 days back, or the oldest one there is (said as "trend
    from <date>"). A grey line, a line whose source was missed or failed (no number), and a line
    read only in part (`partial`) store nothing and have no direction."""
    today = london_day(now)
    hist = merge_history(history)
    snap = dict(hist.get(today) or {})
    snap.update({l["key"]: l["number"] for l in lines
                 if isinstance(l.get("number"), (int, float)) and not l.get("partial")})
    hist[today] = snap
    keep = (now.astimezone(LONDON).date() - timedelta(days=HISTORY_DAYS - 1)).isoformat()
    hist = {d: s for d, s in hist.items() if keep <= d <= today}
    week = (now.astimezone(LONDON).date() - timedelta(days=TREND_DAYS)).isoformat()
    for l in lines:
        after = l.get("number")
        earlier = sorted(d for d in hist if d < today and d >= week and l["key"] in hist[d])
        # The day exactly a week back when it exists, otherwise the oldest day inside the week.
        vs = week if week in earlier else (earlier[0] if earlier else None)
        before = hist[vs][l["key"]] if vs else None
        seeded = l.pop("_trendSeed", None)
        if seeded and vs != week:
            vs, before = seeded
        direction = None
        if isinstance(after, (int, float)) and isinstance(before, (int, float)) and not l.get("partial"):
            if after == before:
                direction = "same"
            elif (after < before) == (l["better"] == "lower"):
                direction = "better"
            else:
                direction = "worse"
        l["trend"] = {"vsDate": vs, "before": before, "after": after, "direction": direction,
                      "fullWeek": vs == week, "since": min(hist) if hist else today}
        if l.get("partial"):
            l["trend"]["partial"] = True
    return hist


def group_verdicts(lines):
    out = []
    for key, title in GROUPS:
        ls = [l for l in lines if l["group"] == key]
        counts = {c: sum(1 for l in ls if l["colour"] == c) for c in COLOURS}
        colour = "red" if counts["red"] else "amber" if counts["amber"] else "grey" if counts["grey"] == len(ls) \
            else "amber" if counts["grey"] else "green"
        if counts["red"] or counts["amber"]:
            text = ", ".join(t for t in ("%d red" % counts["red"] if counts["red"] else "",
                                         "%d amber" % counts["amber"] if counts["amber"] else "") if t)
        else:
            text = "All %d green" % len(ls) if not counts["grey"] else "%d green" % counts["green"]
        if counts["grey"]:
            text += ", %d can't tell" % counts["grey"]
        out.append({"key": key, "title": title, "colour": colour, "text": text, "counts": counts})
    return out


def overall_verdict(lines):
    """One answer, never better than the truth (review of PR #790), in this order:
      1. a red line worse than a week ago: red "Needs attention: <that line>";
      2. more than 2 lines that cannot be read: grey "Can't tell" (or red, naming the worst red
         line, when a red is already known: a known red is never hidden behind "can't tell");
      3. no red and at most 2 amber: green "Healthy", or amber "Healthy where it can be read"
         when 1 or 2 lines cannot be read;
      4. reds or ambers, with more of THOSE lines better than worse than a week ago: amber
         "Issues, but going the right way" (green lines improving never count);
      5. otherwise red "Needs attention: <worst line>".
    Grey lines are always named."""
    reds = [l for l in lines if l["colour"] == "red"]
    ambers = [l for l in lines if l["colour"] == "amber"]
    greys = [l for l in lines if l["colour"] == "grey"]
    issues = reds + ambers
    direction = lambda l: (l.get("trend") or {}).get("direction")   # noqa: E731
    better = sum(1 for l in issues if direction(l) == "better")
    worse = sum(1 for l in issues if direction(l) == "worse")
    worsening = [l for l in reds if direction(l) == "worse"]
    worst = worsening[0] if worsening else reds[0] if reds else ambers[0] if ambers else None
    if worsening:
        colour, text = "red", "Needs attention: %s" % worsening[0]["question"]
    elif len(greys) > 2 and not reds:
        colour, text = "grey", "Can't tell"
    elif len(greys) > 2:
        colour, text = "red", "Needs attention: %s" % worst["question"]
    elif not reds and len(ambers) <= 2:
        colour, text = ("green", "Healthy") if not greys else ("amber", "Healthy where it can be read")
    elif better > worse:
        colour, text = "amber", "Issues, but going the right way"
    else:
        colour, text = "red", "Needs attention: %s" % worst["question"]
    if greys:
        named = "%s can't be read: %s" % (plural(len(greys), "line"), ", ".join(l["question"] for l in greys))
        text = (text + ": " + named) if colour == "grey" else (text + " · " + named)
    return {"colour": colour, "text": text, "worst": worst["key"] if worst else None,
            "red": len(reds), "amber": len(ambers), "green": sum(1 for l in lines if l["colour"] == "green"),
            "grey": len(greys), "greyLines": [l["key"] for l in greys], "better": better, "worse": worse}


def build_payload(lines, history, now, history_check=None):
    hist = apply_history(lines, history, now)
    return {"version": 1, "computedAt": now.strftime("%Y-%m-%dT%H:%M:%S.000Z"),
            "overall": overall_verdict(lines), "groups": group_verdicts(lines), "lines": lines,
            "history": hist, "historyCheck": history_check}


# ─── the readers: each returns facts for one judge, or {"error": why} ──
def _open(f, closed):
    return (f.get("Status") or "") not in closed and not f.get("Completion Date")


def _agent_ids(team):
    return {r["id"] for r in team or [] if (r.get("fields") or {}).get("Is AI Agent")}


def _owned(f, agents):
    return [x for x in (f.get("Team Member") or []) if x in agents]


def walled_ids(tasks, dispatch, blockers):
    """Every task with an open wall: the sweep's list plus a fresh read of each task's own Notes,
    so a wall opened since the last sweep is never counted as "stuck" too."""
    out = {w.get("task") for w in (blockers or {}).get("open") or [] if w.get("task")}
    for r in tasks or []:
        if dispatch.task_blocker((r.get("fields") or {}).get("Notes")):
            out.add(r["id"])
    return out


def read_blockers(now, path=BLOCKERS_FILE):
    try:
        r = _read_json(path)
        age = (now.timestamp() - os.path.getmtime(path)) / 60
    except FileNotFoundError:
        return {"error": "the blocked-task sweep has written no report"}
    except (OSError, ValueError) as exc:
        return {"error": "the blocked-task sweep's report could not be read (%s)" % str(exc)[:100]}
    if age > BLOCKERS_MAX_MIN:
        return {"error": "the blocked-task sweep has not run for %d hours" % int(age // 60)}
    if not r.get("openTasksRead"):
        return {"error": "the blocked-task sweep could not read the task board"}
    return r


# A wall's kind in plain words (the old Bottleneck card's wording, js/dashboard.js 9 Oct 2026).
WALL_WORDS = {"TOOL": "waiting on a code fix", "KEVIN": "waiting on a step only you can do",
              "SIGN-IN": "waiting on your sign-in", "SITE": "waiting on a site to be added"}


def facts_bottlenecks(blockers, clock_days, now):
    if blockers.get("error"):
        return {"error": blockers["error"]}
    read_at = _aware(blockers.get("readAt"))
    extra_days = (now - read_at).total_seconds() / 86400 if read_at else 0.0
    past, kinds = [], {}
    for w in blockers.get("open") or []:
        kind = w.get("kind") or "?"
        kinds[kind] = kinds.get(kind, 0) + 1
        clock = clock_days.get(kind)
        if clock is None:
            continue                      # a SITE wall has no clock (task-manager.py CLOCK_DAYS)
        days = w.get("days")
        age = None if days is None else float(days) + extra_days
        # A wall nothing can date is treated as past its clock, as the task manager's clock does.
        if age is None or age >= clock:
            past.append(item(w.get("name"), w.get("task"), "%s, %s" % (
                WALL_WORDS.get(kind, kind), "%.1f days (limit %d)" % (age, clock) if age is not None else "no date on the block")))
    by_kind = [[WALL_WORDS.get(k, k).capitalize(), n] for k, n in sorted(kinds.items(), key=lambda kv: -kv[1])]
    return {"past": past, "byKind": by_kind, "total": sum(kinds.values())}


def facts_moving(lh_res, walled, task_names):
    if not lh_res:
        return {"error": "the not-moving check did not run"}
    aw = lh_res.get("agentWork") or {}
    if aw.get("live") is None:
        return {"error": "live work could not be split out (%s)" % (aw.get("splitCheck") or "no split")}
    if aw.get("stuckIds") is None:
        return {"error": "the not-moving check gave no task ids"}
    if aw.get("heldCheck"):
        return {"error": "tasks held under a lead task could not be left out (%s)" % aw["heldCheck"]}
    stuck = [i for i in aw["stuckIds"] if i not in walled]
    split = [["Live", aw.get("live")], ["Waiting for your approval", aw.get("approval")],
             ["Waiting on a reply", aw.get("waitingReply")], ["Scheduled for later", aw.get("scheduled")]]
    if aw.get("other"):
        split.append(["On no board", aw["other"]])
    split.append(["All open agent tasks", aw.get("open")])
    return {"stuck": [item(task_names.get(i, i), i) for i in stuck], "live": aw["live"],
            "walledOut": len(aw["stuckIds"]) - len(stuck), "split": split}


def facts_responses(tasks, agents, lh, dispatch, walled, now):
    closed = lh.CLOSED
    today = london_day(now)
    open_ids = {r["id"] for r in tasks if _open(r.get("fields") or {}, closed)}
    out = []
    for r in tasks:
        f = r.get("fields") or {}
        if not _open(f, closed) or not f.get("Inbound Communication Task") or not _owned(f, agents):
            continue
        if f.get("Agent Output") or f.get("Status") == "Approval" or r["id"] in walled:
            continue
        if not lh.in_dispatch_window(f.get("Status") or "", f.get("Due Date"), today, bool(f.get("Some Day"))):
            continue
        held = lh.HELD_UNDER_RE.search(str(f.get("Notes") or ""))
        if held and held.group(1) in open_ids:
            continue
        made = _aware(f.get("Created Time"))
        waited = working_days_between(made, now)
        if made and waited > INBOUND_WAIT_WORKING_DAYS:
            out.append(item(f.get("Task Name"), r["id"], "%.1f working days without a draft" % waited))
    return {"items": out}


def read_dispatch_queue(now, path=DISPATCH_QUEUE, max_min=DISPATCH_QUEUE_MAX_MIN):
    try:
        q = _read_json(path)
    except FileNotFoundError:
        return {"error": "the dispatcher has written no queue"}
    except (OSError, ValueError) as exc:
        return {"error": "the dispatcher's queue could not be read (%s)" % str(exc)[:100]}
    made = _aware(q.get("generatedAt")) if isinstance(q, dict) else None
    if not made:
        return {"error": "the dispatcher's queue carries no time"}
    if (now - made).total_seconds() / 60 > max_min:
        return {"error": "the dispatcher's queue is from %s (it is written every 30 minutes)" % when_text(made)}
    if not isinstance(q.get("worklist"), list):
        return {"error": "the dispatcher's queue carries no worklist"}
    return q


def facts_carried(queue, now):
    if queue.get("error"):
        return {"error": queue["error"]}
    out, young = [], 0
    for t in list(queue.get("worklist") or []) + list(queue.get("reserve") or []):
        if t.get("kind") != "carry_out":
            continue
        at = _aware(t.get("approvedAt"))
        hours = (now - at).total_seconds() / 3600 if at else None
        if hours is None or hours > APPROVED_CARRY_HOURS:
            out.append(item(t.get("name"), t.get("id"), "approved %s ago" % (
                "an unknown time" if hours is None else "%.0f hours" % hours)))
        else:
            young += 1
    return {"items": out, "young": young}


NOTE_STAMP_RE = re.compile(r"^\[(?P<day>\d{1,2} \w{3} \d{4})(?: (?P<time>\d{2}:\d{2}))?\s*[—–-]\s*(?P<who>[^\]]+)\]\s*(?P<text>.*)$", re.M)
# Lines only an agent's own command writes: its annotate/complete/block lines ("agent"), and the
# dispatcher's stamps of its submit, send and attach. Sweeps and clocks write under other names.
AGENT_ACT_RE = re.compile(r"^(?:SUBMITTED|SENT:|ATTACHED:|Escalated to Kevin)")


def _stamp_time(day, time_):
    try:
        if time_:
            return datetime.strptime("%s %s" % (day, time_), "%d %b %Y %H:%M").replace(tzinfo=LONDON)
        return datetime.strptime(day, "%d %b %Y").replace(tzinfo=LONDON)
    except ValueError:
        return None


def agent_note_acted(notes, now, hours=AGENT_IDLE_HOURS):
    """True when the task's Notes carry an agent's own line from the last `hours`. A line with a
    clock time is judged by it; a line with a date only counts when it is today's (London)."""
    today = now.astimezone(LONDON).date()
    for m in NOTE_STAMP_RE.finditer(str(notes or "")):
        who, text = m.group("who").strip(), m.group("text")
        if not (who == "agent" or (who == "agent-dispatch" and AGENT_ACT_RE.match(text))):
            continue
        t = _stamp_time(m.group("day"), m.group("time"))
        if not t:
            continue
        if m.group("time"):
            if timedelta(0) <= now - t <= timedelta(hours=hours):
                return True
        elif t.date() == today:
            return True
    return False


def report_actions_since(now, hours=AGENT_IDLE_HOURS, base=DISPATCH_DIR):
    """[(when, report dict)] for every dispatch run report written in the last `hours`, oldest
    first. The file's own time is used: half the reports stamp startedAt in London time with a Z."""
    out, bad = [], []
    for p in glob.glob(os.path.join(base, "*", "report.json")):
        try:
            when = datetime.fromtimestamp(os.path.getmtime(p), timezone.utc)
        except OSError:
            continue
        if now - when > timedelta(hours=hours) or when > now + timedelta(minutes=5):
            continue
        try:
            out.append((when, _read_json(p)))
        except (OSError, ValueError):
            bad.append(os.path.basename(os.path.dirname(p)))
    out.sort(key=lambda x: x[0])
    return out, bad


def facts_agents(tasks, team, lh, ledger, held_ids, walled, reports, now):
    agents = _agent_ids(team)
    names = {r["id"]: (r.get("fields") or {}).get("Name") or r["id"] for r in team or []}
    open_ids = {r["id"] for r in tasks if _open(r.get("fields") or {}, lh.CLOSED)}
    owner = {r["id"]: _owned(r.get("fields") or {}, agents) for r in tasks}
    live, acted = {}, set()
    for r in tasks:
        f = r.get("fields") or {}
        who = owner[r["id"]]
        if not who:
            continue
        done = _aware(f.get("Completion Date"))
        if done and timedelta(0) <= now - done <= timedelta(hours=AGENT_IDLE_HOURS):
            acted.update(who)
        if agent_note_acted(f.get("Notes"), now):
            acted.update(who)
        if not _open(f, lh.CLOSED) or r["id"] in walled or r["id"] in (held_ids or ()):
            continue
        held = lh.HELD_UNDER_RE.search(str(f.get("Notes") or ""))
        if held and held.group(1) in open_ids:
            continue
        made = _aware(f.get("Created Time"))
        if not made or now - made < timedelta(hours=AGENT_IDLE_HOURS):
            continue                      # work that arrived today has not had its day yet
        bucket = lh.work_bucket(f, now, None if ledger is None else ledger.get(r["id"], []))[0]
        if bucket == "live":
            for a in who:
                live.setdefault(a, []).append(f.get("Task Name") or r["id"])
    for _when, rep in reports:
        for a in rep.get("actions") or []:
            if a.get("ok") and a.get("task") in owner:
                acted.update(owner[a["task"]])
    rows = [{"id": a, "name": names.get(a, a), "live": len(ts), "tasks": ts[:5], "acted": a in acted}
            for a, ts in live.items()]
    rows.sort(key=lambda x: (x["acted"], -x["live"], x["name"]))
    return {"agents": rows}


ALLOWANCE_STOP = "The Claude allowance ran out"   # estate-status.py BLOCKED_MARKERS[0] and allowance_row


def job_broken(key, status, detail):
    """A board row whose last run failed or was blocked (an expired sign-in, no network, Drive
    unreadable, the lock lost, stopped for running too long: review of PR #790). A Claude limit
    stop is line 14's, and the blocked-tasks report and this panel's own rows are not jobs."""
    if key in ("agent-blockers", "ai-team-health", KEY, "allowance"):
        return False
    if status == "Failed":
        return True
    return status == "Blocked" and not str(detail or "").startswith(ALLOWANCE_STOP)


def facts_jobs(rows, stored, stored_error):
    """Broken rows on the board (job_broken): this pass's rows first, then the rows other
    scripts write, read from the table."""
    seen, failed = set(), []
    for r in rows or []:
        seen.add(r.get("key"))
        if job_broken(r.get("key"), r.get("status"), r.get("detail")):
            failed.append(item(r.get("label") or r.get("key"), "", "%s: %s" % (
                r.get("status"), str(r.get("detail") or "")[:110])))
    for k, s in (stored or {}).items():
        if k in seen or not job_broken(k, s.get("status"), s.get("detail")):
            continue
        failed.append(item(s.get("label") or k, "", "%s: %s" % (s.get("status"), str(s.get("detail") or "")[:110])))
    out = {"failed": failed}
    if stored_error:
        out["error"] = "the rows other jobs write could not be read (%s)" % stored_error
    return out


def facts_bugs(measures):
    if measures.get("error"):
        return {"error": measures["error"]}
    d, rw = measures.get("defects") or {}, measures.get("rework") or {}
    return dict(d, rework=rw)


INVARIANT_LINE_RE = re.compile(r"^(PASS|FAIL|ERROR|BROKEN|WAITING)\s+(\S+)\s*$", re.M)


def read_invariants(path=INVARIANTS_LOG):
    try:
        text = open(path, encoding="utf-8", errors="replace").read()
        ran = datetime.fromtimestamp(os.path.getmtime(path), timezone.utc)
    except FileNotFoundError:
        return {"error": "the data check has never written its log"}
    except OSError as exc:
        return {"error": "the data check's log could not be read (%s)" % str(exc)[:100]}
    marks = INVARIANT_LINE_RE.findall(text)
    broken = [name.replace("-", " ") for mark, name in marks if mark in ("FAIL", "ERROR", "BROKEN")]
    res = re.search(r"^RESULT:\s*(.+)$", text, re.M)
    result = None
    if res:
        result = "pass" if res.group(1).startswith("all invariants hold") else "broken"
    return {"ranAt": ran.strftime("%Y-%m-%dT%H:%M:%SZ"), "result": result, "broken": broken, "checks": len(marks)}


def facts_parks(reports, tasks, agents, lh, dispatch, now, ledger_reader=None):
    """Tasks a run in the last 24 hours left with no card (the dispatcher's own parked_tasks over
    its report) that still have no card, no wall, no door and no later outcome."""
    latest = {}
    for when, rep in reports:
        actions = rep.get("actions") or []
        parked = dispatch.parked_tasks(actions)
        for a in actions:
            if a.get("task"):
                latest[a["task"]] = (when, a["task"] in parked)
    try:
        passes = (ledger_reader or dispatch.load_pass_ledger)()
    except RuntimeError as exc:
        return None, "the no-card pass ledger could not be read (%s)" % str(exc)[:100]
    by_id = {r["id"]: r.get("fields") or {} for r in tasks}
    today = london_day(now)
    out = []
    for tid, (when, parked) in latest.items():
        f = by_id.get(tid)
        if not parked or f is None or not _open(f, lh.CLOSED) or not _owned(f, agents):
            continue
        if f.get("Status") == "Approval" or dispatch.task_blocker(f.get("Notes")):
            continue
        if not lh.in_dispatch_window(f.get("Status") or "", f.get("Due Date"), today, bool(f.get("Some Day"))):
            continue
        began = dispatch.pass_began(passes.get(tid))
        if isinstance(began, datetime) and now - began < timedelta(hours=dispatch.NO_CARD_PASS_HOURS):
            continue
        out.append(item(f.get("Task Name"), tid, "left with no card %s" % when_text(when)))
    return out, None


def facts_gave_up(events, rows, now, stored=None, finishes=None, schedule=None, next_due=None):
    """(missed, late). A job that waited for the queue and gave up, or was skipped as too late,
    in the last 24 hours (queue-events.jsonl) is missed UNLESS it then finished cleanly
    (job-status.jsonl) after its newest give-up and before its next due time: that one ran late,
    and is listed as such but not counted (review of PR #790: the backlog job gave up three times
    and then finished). A job with no schedule has no next due time, so any clean finish after
    the give-up counts as late. Jobs the board marks Missed (no record at their time) are missed."""
    labels = {k: (s or {}).get("label") or k for k, s in (stored or {}).items()}
    labels.update({r.get("key"): r.get("label") or r.get("key") for r in rows or []})
    newest = {}
    for e in events or []:
        t = _aware(e.get("ts"))
        if not t or now - t > timedelta(hours=24) or e.get("state") not in ("queue-timeout", "skipped-stale"):
            continue
        if e.get("job") not in newest or t > newest[e["job"]][0]:
            newest[e["job"]] = (t, e["state"])
    # A clean finish is either log's: run-job.sh writes job-status.jsonl, and a job run through
    # job-queue.py alone (the inbox backlog, 15 Oct 2026) writes only the queue's "finished".
    clean_runs = [(x.get("job"), _aware(x.get("ts"))) for x in finishes or [] if x.get("ok")]
    clean_runs += [(e.get("job"), _aware(e.get("ts"))) for e in events or []
                   if e.get("state") == "finished" and e.get("exit") == 0]
    out, late, seen = [], [], set()
    for job, (t, state) in sorted(newest.items(), key=lambda kv: kv[1][0]):
        seen.add(job)
        cron = ((schedule or {}).get(job) or {}).get("cron")
        due = _aware(next_due(cron, t)) if (cron and next_due) else None
        clean = sorted(at for j, at in clean_runs if j == job and at and at > t and (due is None or at <= due))
        what = "gave up waiting at %s" % when_text(t) if state == "queue-timeout" else "skipped, too late, at %s" % when_text(t)
        if clean:
            late.append(item(labels.get(job, job), "", "%s, then ran cleanly at %s" % (what, when_text(clean[0]))))
        elif due is not None and due <= now:
            out.append(item(labels.get(job, job), "", "%s, and did not run before its next time, %s" % (what, when_text(due))))
        else:
            out.append(item(labels.get(job, job), "", "%s, and has not run cleanly since" % what))
    for r in rows or []:
        if r.get("status") == "Missed" and r.get("key") not in seen:
            seen.add(r.get("key"))
            out.append(item(r.get("label") or r.get("key"), "", "did not run at its time"))
    return out, late


def read_triage(now, tri, es, base=TRIAGE_DIR):
    """The inbox facts for lines 1 and 10. Uses inbound-triage.py's own readers (its slot record,
    its digests, its scan snapshot), never a parse of the prose in runs.log."""
    try:
        state = _read_json(os.path.join(base, "state.json"))
    except FileNotFoundError:
        return {"error": "the inbox sort has no state file"}
    except (OSError, ValueError) as exc:
        return {"error": "the inbox sort's state file could not be read (%s)" % str(exc)[:100]}
    detail = state.get("history_detail") or {}
    days = sorted(d for d in detail if isinstance(detail.get(d), dict))
    scanned = state.get("last_scan_ok_ms")
    out = {"scannedAt": datetime.fromtimestamp(int(scanned) / 1000, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
           if scanned else None}
    if days:
        last = detail[days[-1]]
        out["left"] = last.get("inbox_over_2_days")
        out["truncated"] = bool(last.get("inbox_listing_truncated"))
        out["scoredDay"] = days[-1]
    else:
        out["error"] = "the inbox sort has not counted old mail yet"
    # The slot: the newest firing of the job's own cron that is past its grace, and its verdict.
    cfg = es.load_schedule().get("inbound-triage") or {}
    due = es.last_due(cfg.get("cron", ""), now - timedelta(minutes=TRIAGE_SLOT_GRACE_MIN))
    if due is None:
        out["slotError"] = "the inbox sort's schedule could not be read"
    else:
        rows = tri.read_slot_results(os.path.join(base, tri.SLOT_RESULTS_FILE))
        if rows is None:
            out["slotError"] = "the inbox sort's slot record could not be read"
        else:
            name, day = due.astimezone(LONDON).strftime("%H:%M"), due.astimezone(LONDON).date().isoformat()
            mine = [r for r in tri.collapse_slots(rows) if r.get("lane") == "email" and r.get("slot") == name
                    and (r.get("date") or str(r.get("ts") or "")[:10]) == day]
            if not mine:
                out["slot"] = {"name": name, "date": day, "state": "missed", "reason": "no record at its time"}
            else:
                v = mine[-1]
                out["slot"] = {"name": name, "date": day, "state": "ok" if v.get("ok") else "failed",
                               "reason": v.get("reason") or ""}
                # The record is written BEFORE the run (review of PR #790): a run killed or frozen
                # part way still reads ok. Once the slot is past its own run limit, it must have
                # written its end line after it started, or it did not finish.
                limit = float(cfg.get("maxRuntimeMinutes") or TRIAGE_DEFAULT_RUN_MIN) + TRIAGE_FINISH_GRACE_MIN
                if out["slot"]["state"] == "ok":
                    rc, err = run_end_after(os.path.join(base, "runs.log"), due)
                    if err:
                        out["slotError"] = err
                    elif rc is not None and rc != 0:
                        out["slot"].update(state="errored", reason="its run ended with exit code %d" % rc)
                    elif rc is None and now >= due + timedelta(minutes=limit):
                        out["slot"].update(state="unfinished", reason="no end line in its run log %d minutes after it began"
                                           % int((now - due).total_seconds() // 60))
    # The mail itself: the scan's old-mail snapshot, minus what was moved or deferred since.
    snap = state.get("last_scan_stale") or {}
    ids, at_ms = snap.get("ids"), snap.get("at_ms")
    if isinstance(ids, list) and at_ms:
        try:
            moved = tri.digest_moved_ids_since(at_ms, base)
            deferred = tri.digest_ids_since(at_ms, lambda do: do == "deferred", base)
            last = tri.digest_last_decisions(base)
            cache = {}
            try:
                cache = _read_json(os.path.join(base, "scan-cache.json"))
            except (OSError, ValueError):
                cache = {}
            def name_of(i):
                c = cache.get(i) or {}
                return "%s: %s" % (c.get("sender") or "unknown sender", c.get("subject") or "(no subject)")
            left = [i for i in ids if i not in moved and i not in deferred]
            out["items"] = [item(name_of(i), i) for i in left]
            undecided = [i for i in ids if i not in moved
                         and str((last.get(i) or {}).get("do") or "") in tri.TRIAGE_AGAIN_DOS]
            out["undecided"] = [item(name_of(i), i, "no decision yet") for i in undecided]
            out["snapshotAt"] = datetime.fromtimestamp(int(at_ms) / 1000, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        except Exception as exc:  # noqa: BLE001 — the line says it could not read the mail, never a zero
            out["mailError"] = "the inbox sort's decisions could not be read (%s)" % str(exc)[:100]
    else:
        out["mailError"] = "the last scan kept no list of old mail"
    return out


DONE_LINE_RE = re.compile(r"^===== done rc=(-?\d+) (\w{3} \w{3} +\d{1,2} \d{2}:\d{2}:\d{2}) \w+ (\d{4}) =====\s*$", re.M)
RUN_LOG_TAIL = 300_000


def _log_time(stamp, year):
    """'Thu Oct 15 09:47:56' + '2026', written by the runners in London time."""
    try:
        return datetime.strptime("%s %s" % (" ".join(stamp.split()), year), "%a %b %d %H:%M:%S %Y").replace(tzinfo=LONDON)
    except ValueError:
        return None


def _tail(path, size=RUN_LOG_TAIL):
    with open(path, "rb") as fh:
        fh.seek(0, os.SEEK_END)
        fh.seek(max(0, fh.tell() - size))
        return fh.read().decode("utf-8", "replace")


def run_end_after(path, start):
    """(exit code, None) of the first "===== done rc=N <time> =====" line written at or after
    `start` in a runner's log, (None, None) when there is none yet, or (None, why) when the log
    cannot be read."""
    try:
        text = _tail(path)
    except FileNotFoundError:
        return None, None
    except OSError as exc:
        return None, "the inbox run log could not be read (%s)" % str(exc)[:80]
    for m in DONE_LINE_RE.finditer(text):
        t = _log_time(m.group(2), m.group(3))
        if t and t >= start:
            return int(m.group(1)), None
    return None, None


def facts_emails(t):
    """A slot known to have failed or been missed is red whatever else could be read; any other
    gap is "Can't tell"."""
    slot = t.get("slot") or {}
    if slot.get("state") in SLOT_BAD:
        return {"slot": slot, "left": t.get("left"), "items": t.get("items") or ()}
    for k in ("error", "slotError"):
        if t.get(k):
            return {"error": t[k]}
    scanned = _aware(t.get("scannedAt"))
    if scanned and t.get("scoredDay") and t["scoredDay"] < london_day(scanned):
        return {"error": "the last sort (%s) did not record its count of old mail" % when_text(scanned)}
    return {"left": t.get("left"), "truncated": t.get("truncated"), "scannedAt": t.get("scannedAt"),
            "slot": slot, "items": t.get("items") or ()}


def facts_queue(tasks, now):
    """Cards in Kevin's queue: Status Approval, not put off past today (APV_QUEUE_FORMULA's
    population). Age runs from when the card last reached him: the newest send stamp in its Notes
    (a submit, an escalation, or the KEVIN wall a Your step card waits on), or the day a put-off
    ended, whichever is later. A card with neither is aged from when it was made, and says so.
    Last Updated is not used: any edit moves it."""
    today = now.astimezone(LONDON).date()
    cards, undated = [], 0
    for r in tasks:
        f = r.get("fields") or {}
        if f.get("Status") != "Approval":
            continue
        deferred = str(f.get("Deferred Until") or "")[:10]
        if deferred and deferred > today.isoformat():
            continue
        arrived = None
        for m in NOTE_STAMP_RE.finditer(str(f.get("Notes") or "")):
            text = m.group("text")
            if text.startswith("SUBMITTED") or text.startswith("Escalated to Kevin") \
                    or text.startswith("BLOCKER OPEN (KEVIN"):
                t = _stamp_time(m.group("day"), m.group("time"))
                if t and (arrived is None or t > arrived):
                    arrived = t
        if deferred:
            try:
                back = datetime.strptime(deferred, "%Y-%m-%d").replace(tzinfo=LONDON)
                if arrived is None or back > arrived:
                    arrived = back
            except ValueError:
                pass
        dated = arrived is not None
        if not dated:
            arrived = _aware(f.get("Created Time"))
            undated += 1
        days = max(0.0, (now - arrived).total_seconds() / 86400) if arrived else 0.0
        cards.append({"id": r["id"], "name": f.get("Task Name") or "(untitled)", "days": days, "dated": dated})
    return {"cards": cards, "undated": undated}


def facts_firsttime(decided, tasks, aar, now):
    """decided: the 14-day read. Its control: every decided agent task the main board read can
    see inside the window must be in it, or the read missed some and the line cannot be trusted."""
    cut = now - timedelta(days=DECIDED_DAYS)
    rows = [d for d in aar.decisions_from(decided) if (_aware(d.get("at")) or cut) > cut]
    ids = {r["id"] for r in decided}
    seen = []
    for r in tasks:
        f = r.get("fields") or {}
        at = _aware(f.get("Approved At"))
        out = f.get("Approval Outcome")
        out = out if isinstance(out, str) else (out or {}).get("name") if isinstance(out, dict) else None
        if not out or not at or at <= cut:
            continue
        # The same population decisions_from scores: a task with a sender or a holder.
        if not (f.get("Sent For Approval By") or f.get("Team Member")):
            continue
        if aar.form_card(f.get("Task Name"), f.get("Notes")):
            continue
        seen.append(r["id"])
    missing = [i for i in seen if i not in ids]
    if missing:
        return {"error": "the verdicts read missed %d the task board shows (%s)" % (len(missing), ", ".join(missing[:3]))}
    counts = {"asIs": 0, "minor": 0, "changes": 0, "rejected": 0, "other": 0}
    names = {"Approved as-is": "asIs", "Approved with minor edits": "minor", "Changes requested": "changes",
             "Rejected": "rejected"}
    for d in rows:
        counts[names.get(d.get("outcome"), "other")] += 1
    counts["total"] = len(rows)
    counts["control"] = len(seen)
    return counts


LOG_HEADER_RE = re.compile(r"^===== .*? (\w{3} \w{3} +\d{1,2} \d{2}:\d{2}:\d{2}) \w+ (\d{4}) =====\s*$")


def read_limit_hits(now, al, logs_dir=LOGS, days=7):
    """([{job, at, until}], unreadable logs) for every Claude limit line a runner wrote in the
    last `days` (review of PR #790). The guard's allowance.json missed the 3-4 Oct stop; each
    job's runs.log did not. The line is allowance.py's own LIMIT_RE (line start, never prose that
    quotes it), its time the run's next end line (else its start line), its reset the line's own
    words through allowance.py's parse_reset."""
    hits, bad = [], []
    for path in sorted(glob.glob(os.path.join(logs_dir, "*", "runs.log"))):
        job = os.path.basename(os.path.dirname(path))
        try:
            lines = _tail(path).splitlines()
        except OSError:
            bad.append(job)
            continue
        last_start = None
        for i, text in enumerate(lines):
            h = LOG_HEADER_RE.match(text)
            if h and not text.startswith("===== done"):
                last_start = _log_time(h.group(1), h.group(2))
            if not al.LIMIT_RE.search(text):
                continue
            at = None
            for later in lines[i + 1:i + 40]:
                m = DONE_LINE_RE.match(later)
                if m:
                    at = _log_time(m.group(2), m.group(3))
                    break
            at = at or last_start
            if not at or now - at > timedelta(days=days) or at > now + timedelta(minutes=5):
                continue
            until = al.parse_reset(text, at) or (at + timedelta(hours=1))
            hits.append({"job": job, "at": at.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                         "until": until.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")})
    return hits, bad


def _merge_spans(spans):
    out = []
    for a, b in sorted(spans):
        if out and a <= out[-1][1]:
            out[-1] = (out[-1][0], max(out[-1][1], b))
        else:
            out.append((a, b))
    return out


def facts_allowance(al, rows, now, limit_hits=None, unreadable=()):
    try:
        st = al.cmd_status(now=now)
    except Exception as exc:  # noqa: BLE001 — the line says why
        return {"error": "the allowance guard could not be read (%s)" % str(exc)[:100]}
    week = now - timedelta(days=7)
    spans, items = [], []
    paused_until = None

    def add(a, b):
        a, b = _aware(a), _aware(b)
        if a and b and b > week:
            spans.append((max(a, week), b))

    if st.get("paused"):
        add(st.get("seen_at"), st.get("paused_until"))
        paused_until = _aware(st.get("paused_until"))
        items.append(item("Paused now", "", "since %s" % when_text(_aware(st.get("seen_at")))))
    last = st.get("last_outage") or {}
    if last and (_aware(last.get("paused_until")) or week) > week:
        add(last.get("seen_at"), last.get("paused_until"))
        items.append(item("Paused %s to %s" % (when_text(_aware(last.get("seen_at"))),
                                               when_text(_aware(last.get("paused_until")))), ""))
    # Every limit line a runner wrote this week, whether or not the guard saw it (the 3-4 Oct gap).
    for h in limit_hits or []:
        add(h["at"], h["until"])
        if _aware(h["at"]) <= now < _aware(h["until"]):
            paused_until = max(paused_until or _aware(h["until"]), _aware(h["until"]))
    jobs = sorted({h["job"] for h in limit_hits or []})
    if jobs:
        items.append(item("Stopped by the Claude limit: %s" % ", ".join(jobs), "",
                          "%s in the run logs this week" % plural(len(limit_hits), "stop")))
    merged = _merge_spans(spans)
    hours = sum(((min(b, now) - a).total_seconds() / 3600) for a, b in merged if min(b, now) > a)
    # A job whose last run died on the limit says so on the board, even when the guard missed it.
    for r in rows or []:
        if str(r.get("detail") or "").startswith("The Claude allowance ran out"):
            items.append(item(r.get("label") or r.get("key"), "", "its last run hit the Claude limit"))
    out = {"pausedNow": paused_until is not None and now < paused_until,
           "pausedUntil": paused_until.strftime("%Y-%m-%dT%H:%M:%SZ") if paused_until else None, "hours7d": hours,
           "items": items, "lastOutage": last.get("paused_until"), "hits": len(limit_hits or [])}
    if unreadable:
        out["error"] = "%s could not be read for Claude limit stops" % plural(len(unreadable), "run log")
    return out


# ─── Airtable reads (through estate-status.py's own request) ──────────
def _get_all(es, table, params):
    out, offset = [], ""
    while True:
        q = list(params) + [("pageSize", "100")] + ([("offset", offset)] if offset else [])
        import urllib.parse
        d = es._request("GET", table + "?" + urllib.parse.urlencode(q))
        out += d.get("records", [])
        offset = d.get("offset")
        if not offset:
            return out


def read_decided(es, aar, now):
    since = (now - timedelta(days=DECIDED_DAYS + 1)).strftime("%Y-%m-%d")
    formula = ("AND(LEN({Approval Outcome}&'')>0, IS_AFTER({Approved At}, DATETIME_PARSE('%s'))%s)"
               % (since, aar.FORM_KEY_CLAUSE))
    fields = ["Approval Outcome", "Approved At", "Task Type", "Sent For Approval By", "Team Member",
              "Verdict Reason", "Task Name"]
    return _get_all(es, es.TASKS_TABLE, [("filterByFormula", formula)] + [("fields[]", f) for f in fields])


def read_board(es):
    """{key: {status, label, detail}} for every Estate Status row, by field id."""
    want = ("key", "status", "label", "detail")
    rows = _get_all(es, es.TABLE, [("returnFieldsByFieldId", "true")] + [("fields[]", es.ES[k]) for k in want])
    out = {}
    for r in rows:
        f = r.get("fields") or {}
        k = f.get(es.ES["key"])
        if k:
            out[k] = {"status": f.get(es.ES["status"]), "label": f.get(es.ES["label"]),
                      "detail": f.get(es.ES["detail"])}
    return out


def read_history(es):
    """(history, None) from this row's own payload, or ({}, why not)."""
    try:
        rows = _get_all(es, es.TABLE, [("returnFieldsByFieldId", "true"),
                                       ("filterByFormula", "{Key}='%s'" % KEY), ("fields[]", es.ES["payload"])])
    except Exception as exc:  # noqa: BLE001
        return {}, "the row's own history could not be read (%s)" % str(exc)[:100]
    if not rows:
        return {}, None                   # the first run: no row yet, nothing lost
    try:
        p = json.loads((rows[0].get("fields") or {}).get(es.ES["payload"]) or "{}")
    except ValueError:
        return {}, "the row's payload is not readable"
    return (p.get("history") or {}), None


def read_mirror(path=HISTORY_MIRROR):
    try:
        return _read_json(path), None
    except FileNotFoundError:
        return {}, None
    except (OSError, ValueError) as exc:
        return {}, "the local history copy could not be read (%s)" % str(exc)[:100]


def write_mirror(history, path=HISTORY_MIRROR):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(history, fh)
    os.replace(tmp, path)       # atomic: a reader never sees half a history


# ─── one pass ─────────────────────────────────────────────────────────
def gather(now, es, rows, lh_res, lh_err, measures, readers=None):
    """Every line's facts, read once. `readers` overrides any source for a test."""
    rd = readers or {}
    lh = rd.get("lh") or es.loop_health_module()
    dispatch = lh.dispatcher()
    tm = rd.get("tm") or _load("task_manager_for_verdict", "task-manager.py")
    tri = rd.get("tri") or _load("inbound_triage_for_verdict", "inbound-triage.py")
    aar = rd.get("aar") or _load("agent_accuracy_for_verdict", "agent-accuracy-report.py")
    al = rd.get("al") or _load("allowance_for_verdict", "allowance.py")

    no_board = None
    if lh_err is not None or not lh_res or "_tasks" not in lh_res:
        no_board = "the task board read failed (%s)" % (lh_err or "no tasks handed on")
    tasks = (lh_res or {}).get("_tasks") or []
    team = (lh_res or {}).get("_team") or []
    agents = _agent_ids(team)
    names = {r["id"]: (r.get("fields") or {}).get("Task Name") or r["id"] for r in tasks}

    blockers = (rd["blockers"]() if "blockers" in rd else read_blockers(now))
    walled = walled_ids(tasks, dispatch, None if blockers.get("error") else blockers)
    queue = rd["queue"]() if "queue" in rd else read_dispatch_queue(now)
    reports, bad_reports = rd["reports"]() if "reports" in rd else report_actions_since(now)
    tri_facts = rd["triage"]() if "triage" in rd else read_triage(now, tri, es)

    f = {}
    f["emails"] = facts_emails(tri_facts)
    f["responses"] = {"error": no_board} if no_board else facts_responses(tasks, agents, lh, dispatch, walled, now)
    if no_board:
        f["moving"] = {"error": no_board}
    elif blockers.get("error"):
        f["moving"] = {"error": "blocked tasks could not be taken out first (%s)" % blockers["error"]}
    else:
        f["moving"] = facts_moving(lh_res, walled, names)
    f["bottlenecks"] = facts_bottlenecks(blockers, tm.CLOCK_DAYS, now)
    f["carried"] = facts_carried(queue, now)
    # A held list the poll could not give is not fatal here: the HELD UNDER note on each task is
    # read as well, so a held sibling is still left out.
    f["agents"] = {"error": no_board} if no_board else facts_agents(
        tasks, team, lh, lh_res.get("_ledger"), lh_res.get("_heldIds"), walled, reports, now)

    try:
        stored, stored_err = (rd["board"]() if "board" in rd else read_board(es)), None
    except Exception as exc:  # noqa: BLE001
        stored, stored_err = {}, str(exc)[:100]
    f["jobs"] = facts_jobs(rows, stored, stored_err)
    f["bugs"] = facts_bugs(measures)
    f["data"] = rd["invariants"]() if "invariants" in rd else read_invariants()

    errors = []
    parks = []
    if no_board:
        errors.append(no_board)
    else:
        parks, perr = facts_parks(reports, tasks, agents, lh, dispatch, now, rd.get("passes"))
        if perr:
            errors.append(perr)
    if bad_reports:
        errors.append("%s could not be read" % plural(len(bad_reports), "run report"))
    events = rd["events"]() if "events" in rd else es.read_jsonl(
        es.QUEUE_LOG, (now - timedelta(hours=25)).strftime("%Y-%m-%dT%H:%M:%S"))
    if events is None:
        errors.append("the job queue log is missing")
    finishes = rd["finishes"]() if "finishes" in rd else es.read_jsonl(
        es.STATUS_LOG, (now - timedelta(hours=25)).strftime("%Y-%m-%dT%H:%M:%S"))
    schedule = rd["schedule"]() if "schedule" in rd else es.load_schedule()
    if finishes is None:
        errors.append("the job finish log is missing")
    gave, late = facts_gave_up(events or [], rows, now, stored, finishes or [], schedule, getattr(es, "next_due", None))
    undecided = tri_facts.get("undecided")
    if undecided is None:
        errors.append(tri_facts.get("mailError") or tri_facts.get("error") or "the inbox decisions were not read")
    f["missed"] = {"parks": parks, "gaveUp": gave, "late": late, "undecided": undecided or [], "errors": errors}

    flow = (lh_res or {}).get("flow") or {}
    f["ontop"] = {"error": no_board} if no_board else {"in": flow.get("agentCreated7d"), "done": flow.get("agentDone7d")}
    f["queue"] = {"error": no_board} if no_board else facts_queue(tasks, now)
    if no_board:
        f["firsttime"] = {"error": no_board}
    else:
        try:
            decided = rd["decided"]() if "decided" in rd else read_decided(es, aar, now)
            f["firsttime"] = facts_firsttime(decided, tasks, aar, now)
        except Exception as exc:  # noqa: BLE001
            f["firsttime"] = {"error": "your verdicts could not be read (%s)" % str(exc)[:100]}
    hits, unreadable = rd["limitHits"]() if "limitHits" in rd else read_limit_hits(now, al)
    f["allowance"] = facts_allowance(al, rows, now, hits, unreadable)
    return f


def judge_all(f, now):
    lines = [
        judge_emails(f["emails"], now), judge_responses(f["responses"]), judge_moving(f["moving"]),
        judge_bottlenecks(f["bottlenecks"], now), judge_carried(f["carried"]), judge_agents(f["agents"]),
        judge_jobs(f["jobs"]), judge_bugs(f["bugs"]), judge_data(f["data"], now), judge_missed(f["missed"]),
        judge_ontop(f["ontop"]), judge_queue(f["queue"]), judge_firsttime(f["firsttime"]),
        judge_allowance(f["allowance"], now),
    ]
    # No bugs or errors can show a real week's trend from its first day: the queue's own log
    # says what was open 7 days ago, so that seeds the trend until the history holds a week.
    b = f.get("bugs") or {}
    if isinstance(b.get("codeWeekAgo"), int):
        bugs = next(l for l in lines if l["key"] == "bugs")
        bugs["_trendSeed"] = ((now.astimezone(LONDON).date() - timedelta(days=TREND_DAYS)).isoformat(), b["codeWeekAgo"])
    return lines


def verdict_row(now, es, rows, lh_res, lh_err, measures, readers=None, write_history=True):
    """The Estate Status row. Any line that cannot be read is grey inside it; the row itself is
    Failed only when the verdict could not be built at all."""
    stamp = now.strftime("%Y-%m-%dT%H:%M:%S.000Z")
    row = {"key": KEY, "kind": "report", "label": LABEL, "lastRun": stamp}
    rd = readers or {}
    try:
        facts = gather(now, es, rows, lh_res, lh_err, measures, readers)
        lines = judge_all(facts, now)
        if "history" in rd:
            history, hcheck = rd["history"]()
        else:
            stored, err1 = read_history(es)
            mirror, err2 = read_mirror()
            history = merge_history(stored, mirror)
            hcheck = "; ".join(e for e in (err1, err2) if e) or None
        payload = build_payload(lines, history, now, hcheck)
        if write_history and "history" not in rd:
            try:
                write_mirror(payload["history"])
            except OSError as exc:
                payload["historyCheck"] = ((hcheck + "; ") if hcheck else "") + \
                    "the local history copy could not be written (%s)" % str(exc)[:80]
    except Exception as exc:  # noqa: BLE001 — the row says why, never an empty all-clear
        # payload "" is written (estate-status.py to_fields writes any value that is not None), so
        # the last good verdict can never sit under a fresh Last Run (review of PR #790). The
        # trend history survives in the local mirror.
        return dict(row, status="Failed", payload="", detail="The AI team verdict could not be built: %s: %s" % (
            type(exc).__name__, str(exc)[:240]))
    o = payload["overall"]
    detail = "%s. %d green, %d amber, %d red%s." % (
        o["text"], o["green"], o["amber"], o["red"], (", %d can't tell" % o["grey"]) if o["grey"] else "")
    return dict(row, status="Worked", detail=detail, payload=json.dumps(payload), lastWorked=stamp)


# ─── command line ─────────────────────────────────────────────────────
def _estate():
    return _load("estate_status_for_verdict", "estate-status.py")


def cmd_dry_run(out=None):
    """Build every row the ten-minute pass builds, then this one, and print the lines with the
    evidence behind each number. Reads only: no Estate Status write, no history file write.
    `out` saves the row as built, for a page check against real numbers; it names people and
    properties, so it belongs in a scratch folder, never the repo."""
    es = _estate()
    now = datetime.now(timezone.utc)
    rows = es.build_rows(now, with_loop_health=True, with_verdict=False)
    lh_res, lh_err = es.LAST_LOOP_HEALTH.get("res"), es.LAST_LOOP_HEALTH.get("err")
    measures = es.LAST_LOOP_HEALTH.get("measures") or {"error": "not measured"}
    row = verdict_row(now, es, rows, lh_res, lh_err, measures, write_history=False)
    if row["status"] != "Worked":
        print(row["detail"])
        return 1
    if out:
        if os.path.realpath(out).startswith(os.path.realpath(os.path.dirname(HERE)) + os.sep):
            print("Refusing to save the row inside the repo: it names people and properties (the repo is public).")
            return 2
        with open(out, "w", encoding="utf-8") as fh:
            json.dump(row, fh)
    p = json.loads(row["payload"])
    print("OVERALL: %s [%s]" % (p["overall"]["text"], p["overall"]["colour"]))
    for g in p["groups"]:
        print("  %s %s [%s]" % (g["title"], g["text"], g["colour"]))
    for l in p["lines"]:
        t = l.get("trend") or {}
        print("%2d %-6s %-38s %-48s number=%s%s trend=%s→%s (%s, vs %s)" % (
            l["n"], l["colour"], l["question"], l["answer"][:48], l["number"], l["unit"],
            t.get("before"), t.get("after"), t.get("direction"), t.get("vsDate")))
        print("      source: %s" % l["source"])
        for a, b in l["extra"]:
            print("      %s: %s" % (a, b))
        for it in l["items"]:
            print("      - %s%s%s" % (it.get("id", "") + " " if it.get("id") else "", it["name"][:70],
                                    " (" + it["note"] + ")" if it.get("note") else ""))
    if p.get("historyCheck"):
        print("HISTORY: %s" % p["historyCheck"])
    return 0


def selftest():
    now = datetime(2026, 10, 15, 11, 0, tzinfo=timezone.utc)
    checks = 0
    assert judge_emails({"error": "x"}, now)["colour"] == "grey"; checks += 1
    assert judge_emails({"left": 0, "scannedAt": "2026-10-15T08:48:00Z", "slot": {"state": "ok"}}, now)["colour"] == "green"; checks += 1
    assert judge_emails({"left": 6, "scannedAt": "2026-10-15T08:48:00Z", "slot": {"state": "ok"}}, now)["colour"] == "red"; checks += 1
    assert judge_emails({"left": 0, "scannedAt": "2026-10-15T08:48:00Z", "slot": {"state": "missed", "name": "09:00"}}, now)["colour"] == "red"; checks += 1
    assert judge_moving({"stuck": [item("a")] * 3, "live": 30})["colour"] == "green"; checks += 1
    assert working_days_between(datetime(2026, 10, 16, 17, 0, tzinfo=LONDON), datetime(2026, 10, 19, 9, 0, tzinfo=LONDON)) < 1; checks += 1
    lines = [grey(d["key"], "x") for d in LINES]
    assert overall_verdict(lines)["colour"] != "green"; checks += 1
    return {"checks": checks, "failed": []}


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    cmd = argv[0] if argv else ""
    if cmd == "dry-run":
        return cmd_dry_run(argv[argv.index("--out") + 1] if "--out" in argv[:-1] else None)
    if cmd == "selftest":
        try:
            print(json.dumps(selftest()))
            return 0
        except AssertionError as exc:
            print(json.dumps({"checks": 0, "failed": [str(exc)]}))
            return 1
    print(__doc__.split("Usage:")[1].split("Auth:")[0].strip())
    return 2


if __name__ == "__main__":
    sys.exit(main())
