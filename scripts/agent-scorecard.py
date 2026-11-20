#!/usr/bin/env python3
"""Agent chats: the scorecard each chat opens with (Kevin, 17 and 18 Nov 2026).

WHY THIS EXISTS
---------------
Kevin asked on 17 Nov 2026 to talk to each AI agent on its own, the way Grok Bot works, and on
18 Nov (his handwritten note) for a Claude Code section per team and performance reports inside
Claude Code. Each agent now has a standing chat in a folder under ~/Projects/kevin-hq/agents/
whose .claude/settings.json runs the chat as that agent. This script is the report half: the
folder's UserPromptSubmit hook runs `agent-scorecard.py hook`, and on Kevin's first message in a
sitting (and again after 3 hours away) the chat gets its scorecard to show at the top of its reply.

WHAT A SCORECARD SAYS, AND WHERE EACH NUMBER COMES FROM
--------------------------------------------------------
- Score: the agent's own reading, the AI Agents register's Metric Score. A reading over a week
  old is labelled with its date, and an undated one says so: never shown as current.
  Two live overrides, because their register readings only move when someone opens a page:
    * Accounts Receivable: the Estate Status `rent-position` row the daily rent check writes.
    * Bookkeeper: worked out here from the AI Recon Audit table, last 31 days, the same rule as
      js/reconciliation.js refreshReconAccuracyStats (Was Accurate over every row; the
      auto-eligible slice on its own).
- Target: the register's Score Metric.
- Hand-back: the `ai-team-verdict` Estate Status row's hand-back line, `byAgent`, which
  scripts/ai_team_health.py writes every ten minutes. The AI Agents page reads the same row, so
  the two can never disagree. Over 2 hours old, or grey, says "can't tell", never a number.
- Last 7 days: the agent's approval cards Kevin decided in the last 7 days (Tasks, Approved At),
  by outcome. A card belongs to the AI that raised it (Sent For Approval By), else to the AI on
  it (Team Member): the hand-back's own rule (ai_team_health.facts_handback).

A source that cannot be read prints "unavailable: <why>" on its line. Never a zero.

LAST TIME WE SPOKE (Kevin's note, 19 Nov 2026)
-----------------------------------------------
"How do we manage the context capping out in each conversation and how can we ensure that the
agents do not forget things discussed in previous communications?" A full chat is summarised by
Claude Code and detail drops; a new chat starts blank. So the same hook also:
- Recalls: with the scorecard, and again on the first message after a summary, the chat gets
  Kevin's last questions in this chat (every saved conversation in the chat's folder, the primary
  record) with the first line of each answer, and the last lines written down in the brain from
  this chat (CEO Conversations/<date> <plain name> chat.md).
- Logs: every finished question and answer becomes one line in that brain log, marked
  "Q&A (auto)", written when Kevin sends his next message. A plain question used to leave no
  record past Claude Code's own 30-day transcript clean-up.
Kevin's own words are what he typed: system reminders the app puts in front, tool results, the
summary Claude Code writes and the setup prompt that opened the chat are never his.

Usage:
  python3 scripts/agent-scorecard.py hook                 UserPromptSubmit hook (JSON on stdin)
  python3 scripts/agent-scorecard.py show <chat>          print one chat's scorecard
  python3 scripts/agent-scorecard.py recall <chat>        print the LAST TIME WE SPOKE block
  python3 scripts/agent-scorecard.py usage [--days 14]    Kevin's messages per chat, for the review
  python3 scripts/agent-scorecard.py selftest             offline checks, JSON {checks, failed}
Auth: ~/.config/od/airtable_pat (never printed). Read-only: this file has no write path to Airtable.
"""
import json
import math
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from agent_email_format import form_card  # noqa: E402  the hand-back's own exclusion

LONDON = ZoneInfo("Europe/London")
HOME = os.path.expanduser("~")
AGENTS_ROOT = os.path.join(HOME, "Projects", "kevin-hq", "agents")
STATE_DIR = os.environ.get("AGENT_SCORECARD_STATE") or os.path.join(
    os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(HOME, ".claude"), "state", "agent-scorecard")
PROJECTS_DIR = os.path.join(os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(HOME, ".claude"), "projects")

BASE_ID = os.environ.get("AIRTABLE_BASE_ID", "appnqjDpqDniH3IRl")
PAT_FILE = os.environ.get("AIRTABLE_PAT_FILE", os.path.join(HOME, ".config", "od", "airtable_pat"))
API = "https://api.airtable.com/v0"
REGISTER = "tbl9msVjyQWslLOIZ"      # AI Agents
ESTATE = "tblZVrdzivyBueZVf"        # Estate Status
RECON_AUDIT = "tblbfuxYxu4uMMWwT"   # AI Recon Audit
RA_DATE, RA_OK, RA_SLICE = "fldJC9UcHCaXAaxKV", "fld9n62GxQijQWqSA", "fldzAqifUzN5HIQpE"

BRAIN = os.environ.get("OD_BRAIN_DIR") or os.path.join(
    HOME, "Library/CloudStorage/GoogleDrive-kevin@runpreneur.org.uk", "My Drive", "00 AI Context")
CHAT_LOGS = os.path.join(BRAIN, "CEO Conversations")
RECALL_ASKS = 5             # Kevin's last questions shown in LAST TIME WE SPOKE
RECALL_NOTES = 3            # lines written down in the brain shown with them
RECALL_FILES = 10           # newest saved conversations read per chat
RECALL_LOG_FILES = 30       # newest brain log files looked through for written-down lines
ASK_LIMIT = 200             # characters kept of a question or an answer
AUTO_MARK = "Q&A (auto)"    # the hook's own log lines; never shown back as "written down"
SHOW_AGAIN_HOURS = 3        # a scorecard again after Kevin has been away this long
READ_BUDGET_S = 20          # every Airtable read shares this; the hook's own timeout is 60
HANDBACK_STALE_MIN = 120    # the AI Agents page's own HANDBACK_STALE_MIN
OLD_READING_DAYS = 7

# The chats. Folder: AGENTS_ROOT/<team>/<key>. `agent` is the agent file id the folder runs as
# (never renamed); `register` the AI Agents row; `member` the Team Members row.
CHATS = {
    "accounts-receivable": dict(name="Accounts Receivable", team="property", agent="cash-flow-voids",
                                register="reclaAzGLA4utssxx", member="rec7aHLK1Q8fMLRXH", live="rent"),
    "compliance": dict(name="Compliance", team="property", agent="property-administration",
                       register="recZBW9tjcx9WJw4q", member="recwWvBju2ycB63i4"),
    "inbox-triage": dict(name="Inbox Triage", team="inbox", agent="inbound-comms-triage",
                         register="recYy33zkoa099uM2", member="recCUfsTXzmVZynEI"),
    "customer-service": dict(name="Customer Service", team="inbox", agent="inbound-comms-response",
                             register="recHfhVDb6BfQYco5", member="recJ8J8idWE8d97tH"),
    "accounts-payable": dict(name="Accounts Payable", team="money", agent="creditor-management",
                             register="recDvxwDGcC3pFbPa", member="recjh6mmaF8KJW8t3"),
    "social-media-manager": dict(name="Social Media Manager", team="runpreneur", agent="content-engine",
                                 register="recNaC0N5KiTGBPNy", member="recRcy1Edas6rGaaF"),
    "operations-manager": dict(name="Operations Manager", team="whole-team", agent="task-manager",
                               register="reczg8BygPFnJMQnh", member="rec1hYELb4zS8pjjO"),
}
# Scheduled agents: jobs, not chats. Their numbers show in the rooms.
SCHEDULED = {
    "bookkeeper": dict(name="Bookkeeper", register="recyrN5YCQFssAniE", member="recAdy3T0lcr4I9eZ",
                       live="recon"),
    "work-dispatcher": dict(name="Work Dispatcher", register="recmtMtkzeKe1QS9q"),
    "ceo-brief": dict(name="CEO Brief", register="recxcjmdLXQIVfUBQ"),
    "systems-check": dict(name="Systems Check", register="reck8JFedodxc1gfF"),
    "site-tester": dict(name="Site Tester", register="recdTDGFKFPdTWq0R"),
    "knowledge-base-manager": dict(name="Knowledge Base Manager", register="rec45V2cGBBotFXGL"),
    "learning-and-resources-manager": dict(name="Learning and Resources Manager", register="recZMvwnK3wP1J4iv"),
}
# Rooms: a chair that pulls its members in. The CEO room is the whole team.
ROOMS = {
    "property-room": dict(name="Property room", team="property",
                          members=["accounts-receivable", "compliance"], also=[]),
    "inbox-room": dict(name="Inbox room", team="inbox",
                       members=["inbox-triage", "customer-service"], also=[]),
    "money-room": dict(name="Money room", team="money",
                       members=["accounts-payable", "accounts-receivable"], also=["bookkeeper"]),
    "ceo-room": dict(name="CEO room", team="whole-team",
                     members=list(CHATS), also=list(SCHEDULED), whole=True),
}
# A personal chat (Kevin's note, 19 Nov 2026: "who does my personal work like wardrobe management?").
# The agent gate scored it 12/20 and found no repeat work to score an agent on, so it is a chat with no
# agent file, no register row and no scorecard; it still gets LAST TIME WE SPOKE and the Q&A log.
PERSONAL = {
    "personal-assistant": dict(name="Personal Assistant", team="personal"),
}
TEAMS = {"property": "Property team", "inbox": "Inbox team", "money": "Money team", "personal": "Personal",
         "runpreneur": "Runpreneur team", "whole-team": "Whole team"}
MONTHS = {m: i for i, m in enumerate(
    ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], 1)}
# Whole month names only: "3 declined" or "5 marked" is not a date (review of 18 Nov 2026).
DATE_RE = re.compile(r"\b(\d{1,2})\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|"
                     r"aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b\.?(?:\s+(\d{4}))?",
                     re.I)


def all_keys():
    return list(CHATS) + list(ROOMS) + list(PERSONAL)


def spec_for(key):
    return CHATS.get(key) or ROOMS.get(key) or PERSONAL.get(key)


def folder_for(key):
    spec = spec_for(key)
    return os.path.join(AGENTS_ROOT, spec["team"], key) if spec else None


def chat_key(env=None, cwd=None):
    """Which chat this is: OD_AGENT_CHAT from the folder's settings, else the folder's own name
    when it sits where a chat folder should."""
    env = os.environ if env is None else env
    key = (env.get("OD_AGENT_CHAT") or "").strip()
    if spec_for(key):
        return key
    cwd = os.path.realpath(cwd or os.getcwd())
    for k in all_keys():
        if os.path.realpath(folder_for(k)) == cwd:
            return k
    return None


# ----------------------------------------------------------------------------- pure rules

def london(dt):
    return dt.astimezone(LONDON)


def short_day(d):
    return "%d %s" % (d.day, d.strftime("%b"))


def reading_age(text, today):
    """The newest date a register reading names, and a label. A reading older than a week is
    labelled with its age; one that names no date says so (Accounts Payable's "since 18 Nov"
    counts as 18 Nov, the newest date it carries)."""
    newest = None
    for m in DATE_RE.finditer(text or ""):
        day, mon, year = int(m.group(1)), MONTHS[m.group(2).lower()[:3]], m.group(3)
        if mon == 5 and not year:
            continue            # "5 may need a look" is a verb: May counts only with its year
        y = int(year) if year else today.year
        try:
            d = date(y, mon, day)
            if not year and d > today:
                d = date(y - 1, mon, day)   # "since 29 Feb" in a year after a leap year raises here
        except ValueError:
            continue
        if d > today:
            continue            # "next review 30 Nov 2026" is a plan, not when the reading was taken
        if newest is None or d > newest:
            newest = d
    if newest is None:
        return None, "undated reading"
    age = (today - newest).days
    if age > OLD_READING_DAYS:
        return newest, "reading dated %s, %d days old" % (short_day(newest), age)
    return newest, "reading dated %s" % short_day(newest)


def first_line(text, limit=170):
    s = str(text or "").strip().split("\n")[0].strip()
    return s if len(s) <= limit else s[:limit - 1].rstrip() + "…"


def rent_score(row, now):
    """The daily rent check's own line: '58 of 67 tenants paying (86.6%, floor 97.5%). Late: ...'.
    Only the first sentence: the late list names units, which the chat can read for itself."""
    if not row:
        return None, "unavailable: the daily rent check row is missing"
    f = row.get("fields") or {}
    detail = str(f.get("Detail") or "")
    m = re.match(r"\s*(.*?\))\.", detail) or re.match(r"\s*([^.]*)\.", detail)
    head = (m.group(1) if m else first_line(detail)).strip()
    if not head:
        return None, "unavailable: the daily rent check row has no reading"
    when = _parse_time(f.get("Last Run"))
    stamp = ""
    if when:
        stamp = ", daily rent check %s %s" % (short_day(london(when)), london(when).strftime("%H:%M"))
        if now - when > timedelta(hours=36):
            stamp += " (over a day old)"
    verdict = None
    p = re.search(r"\((\d+(?:\.\d+)?)%,\s*floor\s*(\d+(?:\.\d+)?)%\)", head)
    if p:
        verdict = "below target" if float(p.group(1)) < float(p.group(2)) else "on target"
    return verdict, head + stamp


def pct(part, whole):
    """Math.round, as the dashboard: Python's round() sends 94.5 to 94."""
    return int(math.floor(part / whole * 100 + 0.5))   # Math.round((part / whole) * 100), same order


def recon_score(rows, target_pct=95):
    """js/reconciliation.js refreshReconAccuracyStats, the same 31-day window and rule."""
    total = len(rows)
    if not total:
        return None, "no reconciliations checked in the last 31 days"
    ok = sum(1 for r in rows if (r.get("fields") or {}).get(RA_OK))
    auto = [r for r in rows if (r.get("fields") or {}).get(RA_SLICE) == "auto-eligible"]
    auto_ok = sum(1 for r in auto if (r.get("fields") or {}).get(RA_OK))
    p = pct(ok, total)
    text = "%d%% (%d of %d checked, last 31 days)" % (p, ok, total)
    if auto:
        text += "; auto-approve slice %d%% (%d of %d)" % (pct(auto_ok, len(auto)), auto_ok, len(auto))
    text += ", re-measured live"
    return ("below target" if p < target_pct else "on target"), text


def handback_line(payload, now):
    """(line, why): the ai-team-verdict hand-back line, or why it cannot be trusted."""
    if not payload:
        return None, "the AI team row has not been written"
    t = _parse_time(payload.get("computedAt"))
    if not t:
        return None, "the AI team row has no time on it"
    if (now - t) > timedelta(minutes=HANDBACK_STALE_MIN):
        return None, "last worked out %s, over 2 hours ago" % london(t).strftime("%a %H:%M")
    line = next((l for l in payload.get("lines") or [] if l and l.get("key") == "handback"), None)
    if not line:
        return None, "the hand-back score has not been worked out yet"
    if line.get("colour") == "grey":
        return None, str(line.get("why") or "the Mac could not read its sources")
    return line, None


def handback_text(line, why, member):
    if not line:
        return "can't tell (%s)" % why
    a = next((x for x in line.get("byAgent") or [] if x and x.get("id") == member), None)
    if not a:
        return "no cards in 14 days"
    text = "%d of %d cards came back to you (score %d, %s)" % (
        int(a.get("back") or 0), int(a.get("cards") or 0), int(a.get("score") or 0), a.get("colour") or "?")
    reasons = a.get("reasons") or {}
    if reasons:
        text += ": " + ", ".join("%d %s" % (n, k) for k, n in sorted(reasons.items(), key=lambda kv: -kv[1]))
    return text


def raised_by(fields, ai_ids):
    """ai_team_health.facts_handback's rule: the AI that sent it for approval, else the AI on it."""
    for k in ("Sent For Approval By", "Team Member"):
        who = next((x for x in fields.get(k) or [] if x in ai_ids), None)
        if who:
            return who
    return None


def last7(tasks, ai_ids):
    """{member id: {outcome: n}} for cards Kevin decided in the window the read covered."""
    out = {}
    for r in tasks or []:
        f = r.get("fields") or {}
        outcome = f.get("Approval Outcome")
        if not outcome or form_card(f.get("Task Name"), f.get("Notes")):
            continue            # a robot form card or one Kevin works himself: not the agent's card
        who = raised_by(f, ai_ids)
        if who:
            out.setdefault(who, {})
            out[who][outcome] = out[who].get(outcome, 0) + 1
    return out


def last7_text(counts):
    if not counts:
        return "no cards decided"
    total = sum(counts.values())
    order = ["Approved as-is", "Changes requested", "Rejected"]
    parts = ["%d %s" % (counts[k], k.lower()) for k in order if counts.get(k)]
    parts += ["%d %s" % (n, k.lower()) for k, n in sorted(counts.items()) if k not in order]
    return "%d %s decided: %s" % (total, "card" if total == 1 else "cards", ", ".join(parts))


def score_for(key, spec, facts, now):
    """(verdict or None, text) for one agent."""
    reg = (facts.get("register") or {}).get(spec["register"])
    if spec.get("live") == "rent":
        verdict, text = rent_score(facts.get("rent_row"), now)
        if verdict or not text.startswith("unavailable"):
            return verdict, text
    if spec.get("live") == "recon":
        if facts.get("recon_error"):
            return None, "unavailable: %s" % facts["recon_error"]
        if facts.get("recon") is not None:
            return recon_score(facts["recon"])
    if facts.get("register_error"):
        return None, "unavailable: %s" % facts["register_error"]
    if not reg:
        return None, "unavailable: register row %s not found" % spec["register"]
    text = first_line(reg.get("Metric Score"))
    if not text:
        return None, "no reading on the register yet"
    _, label = reading_age(text, london(now).date())
    return None, "%s (%s)" % (text, label)


def target_for(spec, facts):
    if facts.get("register_error"):
        return "unavailable: %s" % facts["register_error"]
    reg = (facts.get("register") or {}).get(spec["register"]) or {}
    return first_line(reg.get("Score Metric"), 200) or "not set on the register"


def agent_block(key, spec, facts, now):
    verdict, score = score_for(key, spec, facts, now)
    lines = ["%s" % spec["name"],
             "  Score: %s%s" % (score, (" -> %s" % verdict.upper()) if verdict else ""),
             "  Target: %s" % target_for(spec, facts)]
    member = spec.get("member")
    if member:
        hb_line, hb_why = facts.get("handback") or (None, "not read")
        lines.append("  Hand-back, 14 days: %s" % handback_text(hb_line, hb_why, member))
        if facts.get("tasks_error"):
            lines.append("  Last 7 days: unavailable: %s" % facts["tasks_error"])
        else:
            lines.append("  Last 7 days: %s" % last7_text((facts.get("last7") or {}).get(member)))
    return lines


def member_line(key, spec, facts, now):
    verdict, score = score_for(key, spec, facts, now)
    parts = ["%s: %s%s" % (spec["name"], score, (" -> %s" % verdict.upper()) if verdict else "")]
    member = spec.get("member")
    if member:
        hb_line, hb_why = facts.get("handback") or (None, "not read")
        a = next((x for x in (hb_line or {}).get("byAgent") or [] if x and x.get("id") == member), None)
        if not hb_line:
            parts.append("hand-back can't tell")
        elif a:
            parts.append("hand-back %d (%d of %d back)" % (int(a["score"]), int(a["back"]), int(a["cards"])))
        else:
            parts.append("no cards in 14 days")
        if facts.get("tasks_error"):
            parts.append("7 days unavailable")
        else:
            c = (facts.get("last7") or {}).get(member) or {}
            if c:
                parts.append("7 days: %d of %d approved as-is" % (c.get("Approved as-is", 0), sum(c.values())))
    return "  " + " | ".join(parts)


def render(key, facts, now):
    """The whole scorecard block for one chat."""
    stamp = "%s %s" % (short_day(london(now)), london(now).strftime("%H:%M"))
    head = ("AGENT CHAT SCORECARD for %s, read %s London. Show this at the top of your reply, "
            "numbers exactly as given; never round, guess or fill in a line marked unavailable."
            % (spec_for(key)["name"], stamp))
    if key in PERSONAL:
        return ("AGENT CHAT SCORECARD for %s, read %s London: none. This is a personal chat, not an agent, "
                "so it has no score; show no scorecard block." % (spec_for(key)["name"], stamp))
    if key in CHATS:
        return "\n".join([head] + agent_block(key, CHATS[key], facts, now))
    room = ROOMS[key]
    out = [head, "Members (pull them in with the Agent tool):"]
    for m in room["members"]:
        out.append(member_line(m, CHATS[m], facts, now))
    if room.get("also"):
        out.append("Scheduled agents (no chat; numbers only):")
        for s in room["also"]:
            out.append(member_line(s, SCHEDULED[s], facts, now))
    if room.get("whole"):
        hb_line, hb_why = facts.get("handback") or (None, "not read")
        out.append("Whole team hand-back, 14 days: %s" % (
            hb_line.get("answer") + " (score %s, %s)" % (hb_line.get("number"), hb_line.get("colour"))
            if hb_line else "can't tell (%s)" % hb_why))
    return "\n".join(out)


def due(state, now):
    """The first message in a session, or the first after Kevin has been away 3 hours."""
    t = _parse_time((state or {}).get("last") or (state or {}).get("shown"))
    return t is None or now - t >= timedelta(hours=SHOW_AGAIN_HOURS)


# ----------------------------------------------------------------------------- reads

def _parse_time(value):
    if not value:
        return None
    try:
        t = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return t if t.tzinfo else t.replace(tzinfo=timezone.utc)


class ReadError(Exception):
    pass


def _token():
    try:
        with open(PAT_FILE) as fh:
            pat = fh.read().strip()
    except OSError as e:
        raise ReadError("cannot read the Airtable token file (%s)" % e.strerror)
    if not pat:
        raise ReadError("the Airtable token file is empty")
    return pat


_DEADLINE = {"at": None}   # monotonic time the whole gather must finish by (gather sets it)


def read_rows(table, formula=None, fields=None, by_field_id=False):
    """Every matching row, paginated. A reply without a records list is an error, never zero.
    Every read shares one budget, so a hung Airtable gives "unavailable" lines inside the hook's
    timeout instead of a killed hook that shows nothing (review of 18 Nov 2026)."""
    if _DEADLINE["at"] and time.monotonic() >= _DEADLINE["at"]:
        raise ReadError("ran out of time reading %s (%d s for every read)" % (table, READ_BUDGET_S))
    pat = _token()
    rows, offset = [], None
    for _ in range(200):
        left = (_DEADLINE["at"] - time.monotonic()) if _DEADLINE["at"] else 10.0
        if left <= 0:
            raise ReadError("ran out of time reading %s (%d s for every read)" % (table, READ_BUDGET_S))
        q = [("pageSize", "100")]
        if formula:
            q.append(("filterByFormula", formula))
        for f in fields or []:
            q.append(("fields[]", f))
        if by_field_id:
            q.append(("returnFieldsByFieldId", "true"))
        if offset:
            q.append(("offset", offset))
        req = urllib.request.Request("%s/%s/%s?%s" % (API, BASE_ID, urllib.parse.quote(table), urllib.parse.urlencode(q)),
                                     headers={"Authorization": "Bearer " + pat})
        try:
            with urllib.request.urlopen(req, timeout=max(1.0, min(10.0, left))) as resp:
                page = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            raise ReadError("Airtable said HTTP %d for %s" % (e.code, table))
        except (urllib.error.URLError, OSError, ValueError) as e:
            raise ReadError("could not reach Airtable (%s)" % e.__class__.__name__)
        if not isinstance(page, dict) or not isinstance(page.get("records"), list):
            raise ReadError("Airtable replied with no records list for %s" % table)
        rows.extend(page["records"])
        offset = page.get("offset")
        if not offset:
            return rows
    raise ReadError("pagination did not finish for %s" % table)


def gather(key, now):
    """Every fact the chat's scorecard needs, each read failing on its own line."""
    if key in PERSONAL:
        return {}   # no register row, nothing to read
    keys = [key] if key in CHATS else ROOMS[key]["members"] + ROOMS[key].get("also", [])
    specs = [CHATS.get(k) or SCHEDULED.get(k) for k in keys]
    facts = {}
    _DEADLINE["at"] = time.monotonic() + READ_BUDGET_S
    try:
        rows = read_rows(REGISTER, fields=["Name", "Metric Score", "Score Metric"])
        if len(rows) < 10:
            raise ReadError("the register read returned %d rows, expected 20 or more" % len(rows))
        facts["register"] = {r["id"]: r.get("fields") or {} for r in rows}
    except ReadError as e:
        facts["register_error"] = str(e)
    try:
        rows = read_rows(ESTATE, formula="OR({Key}='ai-team-verdict',{Key}='rent-position')",
                         fields=["Key", "Detail", "Last Run", "Payload"])
        by = {(r.get("fields") or {}).get("Key"): r for r in rows}
        facts["rent_row"] = by.get("rent-position")
        verdict = by.get("ai-team-verdict")
        payload = None
        if verdict:
            try:
                payload = json.loads((verdict.get("fields") or {}).get("Payload") or "null")
            except ValueError:
                payload = None
        facts["handback"] = handback_line(payload, now)
    except ReadError as e:
        facts["handback"] = (None, str(e))
    if any(s.get("member") for s in specs):
        try:
            team = read_rows("Team Members", formula="{Is AI Agent}", fields=["Name"])
            if not team:
                raise ReadError("no AI rows in Team Members, so the read is wrong")
            ai_ids = {r["id"] for r in team}
            tasks = read_rows("Tasks", formula="IS_AFTER({Approved At}, DATEADD(NOW(), -7, 'days'))",
                              fields=["Task Name", "Notes", "Approval Outcome", "Sent For Approval By", "Team Member"])
            facts["last7"] = last7(tasks, ai_ids)
        except ReadError as e:
            facts["tasks_error"] = str(e)
    if any(s.get("live") == "recon" for s in specs):
        try:
            facts["recon"] = read_rows(RECON_AUDIT, formula="IS_AFTER({Date}, DATEADD(TODAY(), -31, 'days'))",
                                       by_field_id=True)
        except ReadError as e:
            facts["recon_error"] = str(e)
    return facts


# ----------------------------------------------------------------------------- modes

def _state_path(session_id):
    safe = re.sub(r"[^A-Za-z0-9_-]", "", str(session_id or "")) or "unknown"
    return os.path.join(STATE_DIR, safe + ".json")


def _write_state(path, state):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(state, fh)
    os.replace(tmp, path)   # atomic: a reader never sees a half-written file


def cmd_hook(stdin_text, env=None, now=None, gather_fn=gather):
    """UserPromptSubmit: the scorecard and LAST TIME WE SPOKE when they are due, the recall alone
    after Claude Code has summarised the chat, else nothing. Every message also logs the questions
    already answered in this conversation to the brain. Never blocks a prompt."""
    try:
        data = json.loads(stdin_text or "{}")
    except ValueError:
        data = {}
    key = chat_key(env, data.get("cwd"))
    if not key:
        return ""
    now = now or datetime.now(timezone.utc)
    path = _state_path(data.get("session_id"))
    try:
        with open(path) as fh:
            state = json.load(fh)
    except (OSError, ValueError):
        state = {}
    prompt = str(data.get("prompt") or "")
    logged, summarised = state.get("logged"), None
    try:   # the questions this conversation has already answered, one brain line each
        lines = _read_lines(data.get("transcript_path"))
        summarised = compacted_at(lines)
        logged = _within(DRIVE_BUDGET_S, log_exchanges, key, exchanges(lines), logged) or logged
    except Exception:
        pass   # the log is a record, never a reason to cost Kevin his message
    recalled = _parse_time(state.get("recalled"))
    if not due(state, now):
        new = dict(state, last=now.isoformat(), logged=logged)
        text = ""
        if summarised and (recalled is None or summarised > recalled):
            text = recall_block(key, now, prompt, data.get("transcript_path"), after_summary=True)
            new["recalled"] = now.isoformat()
        try:   # Kevin is still here: "away" counts from his latest message
            _write_state(path, new)
        except OSError:
            pass
        return text
    try:
        text = render(key, gather_fn(key, now), now)
    except Exception as e:  # a broken scorecard must never cost Kevin his message
        text = ("AGENT CHAT SCORECARD for %s could not be built (%s). Tell Kevin in one line that "
                "the scorecard is unavailable; never guess its numbers." % (key, e.__class__.__name__))
    text += "\n\n" + recall_block(key, now, prompt, data.get("transcript_path"))
    try:
        _write_state(path, {"shown": now.isoformat(), "last": now.isoformat(), "chat": key,
                            "recalled": now.isoformat(), "logged": logged})
    except OSError as e:
        text += "\n(scorecard state not saved: %s; it will show again next message)" % e.strerror
    return text


# ----------------------------------------------------------------------------- last time we spoke

REMINDER_RE = re.compile(r"<system-reminder>.*?</system-reminder>", re.S)
PASTE_RE = re.compile(r"</?pasted_content[^>]*>")
FENCE_RE = re.compile(r"```.*?```", re.S)
SUMMARY_START = "This session is being continued from a previous conversation"
NOT_KEVIN = (SUMMARY_START, "[Request interrupted", "API Error")
BRIEF_MARK = "Background (from the session that started this one)"
DRIVE_BUDGET_S = 8          # brain folder reads and writes per message; the hook's own timeout is 60


def _within(seconds, fn, *args):
    """fn(*args), or TimeoutError when it takes longer: a stalled Google Drive mount must cost one
    line of the hook, never Kevin's message (review of 19 Nov 2026)."""
    import threading
    box = {}

    def run():
        try:
            box["value"] = fn(*args)
        except Exception as e:   # handed back to the caller below
            box["error"] = e
    worker = threading.Thread(target=run, daemon=True)
    worker.start()
    worker.join(seconds)
    if worker.is_alive():
        raise TimeoutError("took over %ss" % seconds)
    if "error" in box:
        raise box["error"]
    return box.get("value")


def _words(content):
    """The text of a message with the app's reminders and paste tags taken out."""
    if isinstance(content, list):
        content = "\n".join(b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text")
    return PASTE_RE.sub("", REMINDER_RE.sub("", str(content or ""))).strip()


def _kevin(text):
    return bool(text) and not text.startswith("<") and not text.startswith(NOT_KEVIN) \
        and "[agent-chats setup]" not in text and BRIEF_MARK not in text


def turn_start(e):
    """Does this entry start a new turn, and did Kevin type it? None: not a new turn (a tool result,
    a meta entry, a reminder on its own, Claude Code's summary). "": a turn something else started
    (a notice, another session, the setup prompt). Else Kevin's own words.
    A message he types while the agent is still working is saved as a queued_command attachment,
    not a user entry (review of 19 Nov 2026): it counts, and the reply after it is its answer.
    The app puts reminders in front of what he types, in the same block or a block of their own,
    so those are cut out, never used to throw his message away. Where an entry carries an origin,
    only "human" is his."""
    if not isinstance(e, dict) or e.get("isSidechain"):
        return None
    if e.get("type") == "attachment":
        a = e.get("attachment") or {}
        if a.get("type") != "queued_command":
            return None
        origin = a.get("origin") if isinstance(a.get("origin"), dict) else {}
        text = _words(a.get("prompt"))
        if a.get("commandMode") != "prompt" or origin.get("kind") != "human" or not _kevin(text):
            return ""
        return text
    if e.get("type") != "user" or e.get("isMeta") or e.get("isCompactSummary"):
        return None
    content = (e.get("message") or {}).get("content")
    if isinstance(content, list) and any(isinstance(b, dict) and b.get("type") == "tool_result" for b in content):
        return None
    text = _words(content)
    origin = e.get("origin") if isinstance(e.get("origin"), dict) else {}
    if not text:   # a screenshot or a file with no words is still his question (second review)
        kinds = {b.get("type") for b in content if isinstance(b, dict)} if isinstance(content, list) else set()
        if "image" in kinds:
            text = "(a screenshot)"
        elif "document" in kinds:
            text = "(a file)"
        elif origin.get("kind") == "human":
            return ""
        else:
            return None   # a reminder on its own, inside the turn
    if origin.get("kind") not in (None, "human") or not _kevin(text):
        return ""
    return text


def typed_text(e):
    """Kevin's own words in one transcript entry, else None."""
    return turn_start(e) or None


def answer_line(text, limit=ASK_LIMIT):
    """The first real line of a reply: the scorecard's code block and markdown marks left out."""
    for line in FENCE_RE.sub("", str(text or "")).split("\n"):
        line = line.replace("**", "").strip().lstrip("#>*- ").strip()
        if line:
            return first_line(line, limit)
    return ""


def exchanges(lines):
    """Kevin's typed messages in one conversation, oldest first, each with the first line of the
    answer he got: [{"at", "ask", "answer"}]. The answer is the agent's last text before the next
    turn, so a "checking that now" line before a lookup is replaced by the reply itself. A message
    Kevin types while the agent is still working joins the turn: the questions stay open together
    and share the final reply, which answers both (second review). An API error the app writes in
    the agent's place is never an answer."""
    out, open_ = [], []
    for raw in lines:
        try:
            e = json.loads(raw)
        except ValueError:
            continue
        if not isinstance(e, dict):
            continue
        text = turn_start(e)
        if text == "":
            open_ = []
            continue
        if text:
            stamp = e.get("timestamp") or (e.get("attachment") or {}).get("timestamp")
            t = _parse_time(stamp)
            if not t:
                open_ = []
                continue
            ex = {"at": t, "ask": first_line(" ".join(text.split()), ASK_LIMIT), "answer": ""}
            out.append(ex)
            open_ = open_ + [ex] if e.get("type") == "attachment" else [ex]
            continue
        msg = e.get("message") or {}
        if (open_ and e.get("type") == "assistant" and not e.get("isSidechain")
                and not e.get("isApiErrorMessage") and msg.get("model") != "<synthetic>"):
            content = msg.get("content")
            said = ("\n".join(b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text")
                    if isinstance(content, list) else str(content or ""))
            line = answer_line(said)
            if line:
                for ex in open_:
                    ex["answer"] = line
    return out


def compacted_at(lines):
    """When Claude Code last summarised this conversation (its compact boundary), else None."""
    last = None
    for raw in lines:
        if '"compact_boundary"' not in raw:
            continue
        try:
            e = json.loads(raw)
        except ValueError:
            continue
        if isinstance(e, dict) and e.get("type") == "system" and e.get("subtype") == "compact_boundary":
            t = _parse_time(e.get("timestamp"))
            if t and (last is None or t > last):
                last = t
    return last


def _read_lines(path):
    """A saved conversation's lines. A character cut in half (Claude Code writes as Kevin sends)
    is replaced, never a reason to lose the whole hook (review of 19 Nov 2026)."""
    if not path:
        return []
    try:
        with open(os.path.expanduser(path), encoding="utf-8", errors="replace") as fh:
            return fh.read().splitlines()
    except OSError:
        return []


def chat_transcripts(key, extra=None):
    """The chat's saved conversations, newest RECALL_FILES by last change, plus this one."""
    d = project_dir(folder_for(key))
    try:
        paths = [os.path.join(d, x) for x in os.listdir(d) if x.endswith(".jsonl")]
    except OSError:
        paths = []

    def changed(p):
        try:
            return os.path.getmtime(p)
        except OSError:
            return 0
    paths = sorted(paths, key=changed)[-RECALL_FILES:]
    if extra and os.path.realpath(os.path.expanduser(extra)) not in {os.path.realpath(p) for p in paths}:
        paths.append(os.path.expanduser(extra))
    return paths


def chat_log_path(key, day):
    name = spec_for(key)["name"]
    return os.path.join(CHAT_LOGS, "%s %s chat.md" % (day.isoformat(), name))


def written_down(key, limit=RECALL_NOTES):
    """The last lines written down in the brain from this chat, oldest of them first: [(day, line)].
    Reads the newest files first and stops once it has enough. The hook's own Q&A lines are left
    out (they are already in the questions above)."""
    name = spec_for(key)["name"]
    suffix = " %s chat.md" % name
    names = sorted(x for x in os.listdir(CHAT_LOGS) if x.endswith(suffix) and re.match(r"\d{4}-\d{2}-\d{2} ", x))
    notes = []
    for fname in reversed(names[-RECALL_LOG_FILES:]):
        try:
            day = date.fromisoformat(fname[:10])
            with open(os.path.join(CHAT_LOGS, fname), encoding="utf-8", errors="replace") as fh:
                body = fh.read()
        except (OSError, ValueError):
            continue
        lines = [ln.strip() for ln in body.splitlines()]
        found = [(day, first_line(ln[2:], ASK_LIMIT)) for ln in lines if ln.startswith("- ") and AUTO_MARK not in ln]
        notes = found + notes
        if len(notes) >= limit:
            break
    return notes[-limit:]


def recall_text(key, asks, notes, now, after_summary=False, notes_error=None):
    name = spec_for(key)["name"]
    head = ("LAST TIME WE SPOKE (%s chat, read %s London)%s. Read it before you answer and never ask "
            "Kevin to repeat what is here. If he refers to something not listed, search this chat's "
            "logs in the brain (CEO Conversations, \"%s chat\") before saying you do not know."
            % (name, london(now).strftime("%d %b %H:%M"),
               ", after Claude Code summarised this chat: do not show it, just use it" if after_summary
               else ". At the top of your reply (under the scorecard when there is one), one line to Kevin: \"Last time we spoke (<day>): <his last "
                    "question, in a few words>.\" Leave the line out when there is nothing earlier",
               name))
    out = [head, "Kevin's last questions here, oldest first:"]
    if asks:
        for a in asks:
            out.append("- %s: \"%s\" You said: \"%s\"" % (
                london(a["at"]).strftime("%d %b %H:%M"), a["ask"], a["answer"] or "(no answer saved)"))
    else:
        out.append("- none yet: nothing earlier in this chat.")
    out.append("Written down from this chat (brain):")
    if notes_error:
        out.append("- unavailable: %s" % notes_error)
    elif notes:
        out.extend("- %s: %s" % (short_day(d), line) for d, line in notes)
    else:
        out.append("- nothing written down yet.")
    return "\n".join(out)


def recall_block(key, now, prompt="", transcript_path=None, after_summary=False):
    """LAST TIME WE SPOKE for one chat, from its saved conversations and its brain log. A part that
    cannot be read says so; the block itself never fails the hook."""
    try:
        asks = []
        for p in chat_transcripts(key, transcript_path):
            asks.extend(exchanges(_read_lines(p)))
        asks.sort(key=lambda a: a["at"])
        if asks and not asks[-1]["answer"] and asks[-1]["ask"] == first_line(" ".join(prompt.split()), ASK_LIMIT):
            asks.pop()   # the message Kevin is sending now is not "last time"
        try:
            notes, why = _within(DRIVE_BUDGET_S, written_down, key), None
        except OSError as e:
            notes, why = [], "the brain's CEO Conversations folder could not be read (%s)" % (e.strerror or e)
        return recall_text(key, asks[-RECALL_ASKS:], notes, now, after_summary, why)
    except Exception as e:
        return ("LAST TIME WE SPOKE for %s could not be built (%s). Tell Kevin in one line that you cannot "
                "see your earlier chats; never guess what was said." % (key, e.__class__.__name__))


def _append_log_line(key, day, line):
    """One line into the chat's brain log for that day, above its Links footer, once: a line
    already there is left alone, so a retry after a failed or cut-off write never doubles it."""
    path = chat_log_path(key, day)
    name = spec_for(key)["name"]
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            body = fh.read()
    except FileNotFoundError:
        body = "# %s (%s): %s chat\n\nLinks: [[ceo-conversations-moc]]\n" % (day.isoformat(), day.strftime("%A"), name)
    if line in body.splitlines():
        return
    cut = body.rfind("\nLinks:")
    if cut >= 0:
        head = body[:cut].rstrip("\n")
        gap = "\n\n" if "\n" not in head else "\n"   # a blank line under the heading, none between lines
        body = head + gap + line + "\n\n" + body[cut + 1:]
    else:
        body = body.rstrip("\n") + "\n" + line + "\n"
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(body)
    os.replace(tmp, path)


def log_exchanges(key, exs, logged_after):
    """Write each answered question newer than `logged_after` to the brain, one line each, oldest
    first. Returns the time of the newest one written (the new marker), or None if none. A write
    that fails stops the run there; the lines already written keep their marker."""
    after = _parse_time(logged_after)
    newest = None
    for ex in sorted(exs, key=lambda x: x["at"]):
        if not ex["answer"] or (after and ex["at"] <= after):
            continue
        line = "- %s, %s. Kevin: \"%s\" Answer: \"%s\"" % (
            london(ex["at"]).strftime("%H:%M"), AUTO_MARK, ex["ask"], ex["answer"])
        try:
            _append_log_line(key, london(ex["at"]).date(), line)
        except OSError:
            break
        newest = ex["at"]
    return newest.isoformat() if newest else None


def kevin_messages(lines, since):
    """(count, London days) of Kevin's own typed messages in one transcript: tool results,
    system notices, summaries, scheduled runs and the setup prompt that opened the chat do not
    count, and a reminder the app puts in front of his message no longer hides it (19 Nov 2026)."""
    n, days = 0, set()
    for raw in lines:
        try:
            e = json.loads(raw)
        except ValueError:
            continue
        if typed_text(e) is None:
            continue
        t = _parse_time(e.get("timestamp"))
        if not t or t < since:
            continue
        n += 1
        days.add(london(t).date().isoformat())
    return n, sorted(days)


def project_dir(folder):
    return os.path.join(PROJECTS_DIR, re.sub(r"[^A-Za-z0-9]", "-", folder))


def cmd_usage(days=14, now=None):
    now = now or datetime.now(timezone.utc)
    since = now - timedelta(days=days)
    out = {}
    for key in all_keys():
        d = project_dir(folder_for(key))
        n, used = 0, set()
        try:
            names = [x for x in os.listdir(d) if x.endswith(".jsonl")]
        except OSError:
            names = []
        for name in names:
            try:
                with open(os.path.join(d, name)) as fh:
                    c, ds = kevin_messages(fh, since)
            except OSError:
                continue
            n += c
            used.update(ds)
        spec = spec_for(key)
        out[key] = {"name": spec["name"], "section": TEAMS[spec["team"]], "messages": n,
                    "days": len(used), "transcripts": len(names)}
    return {"windowDays": days, "since": since.isoformat(), "chats": out}


# ----------------------------------------------------------------------------- selftest

def selftest():
    failed, checks = [], 0

    def check(name, ok):
        nonlocal checks
        checks += 1
        if not ok:
            failed.append(name)

    now = datetime(2026, 11, 18, 20, 10, tzinfo=timezone.utc)
    today = date(2026, 11, 18)
    # Fixtures shaped from the live records read on 18 Nov 2026 (the gate's worked examples).
    register = {
        "reclaAzGLA4utssxx": {"Name": "Accounts Receivable",
                              "Metric Score": "62 of 64 paying (96.9%) on 2 Oct 2026, from the first live rent check",
                              "Score Metric": "Paid occupancy (live tenancies In Payment / live tenancies) 97.5% or above, target 100%."},
        "recZBW9tjcx9WJw4q": {"Name": "Compliance",
                              "Metric Score": "59 outstanding (21 expired, 36 missing, 2 undated); 1 due in 30 days",
                              "Score Metric": "Outstanding compliance issues trending to zero"},
        "recyrN5YCQFssAniE": {"Name": "Bookkeeper", "Metric Score": "83% (273/327 checked, last 31 days)",
                              "Score Metric": "95% reconciliation accuracy"},
        "recDvxwDGcC3pFbPa": {"Name": "Accounts Payable",
                              "Metric Score": "fixed costs £23,454.88/mo (steady since 18 Nov)", "Score Metric": "x"},
    }
    rent_row = {"fields": {"Key": "rent-position", "Last Run": "2026-11-18T12:39:06.000Z",
                           "Detail": "58 of 67 tenants paying (86.6%, floor 97.5%). Late: Unit 1 (8 days)."}}
    hb = {"key": "handback", "colour": "amber", "answer": "16 of 264 cards came back to you", "number": 94,
          "byAgent": [{"id": "rec7aHLK1Q8fMLRXH", "cards": 23, "back": 0, "score": 100, "reasons": {}, "colour": "green"},
                      {"id": "recwWvBju2ycB63i4", "cards": 35, "back": 2, "score": 94, "colour": "amber",
                       "reasons": {"you did an ID check": 1, "you could not do the step it gave you": 1}}]}
    payload = {"computedAt": "2026-11-18T19:50:05.000Z", "lines": [hb]}
    recon = ([{"fields": {RA_OK: True, RA_SLICE: "auto-eligible"}}] * 107
             + [{"fields": {RA_SLICE: "auto-eligible"}}] * 5
             + [{"fields": {RA_OK: True, RA_SLICE: "other"}}] * 166
             + [{"fields": {RA_SLICE: "other"}}] * 49)
    ai = {"rec7aHLK1Q8fMLRXH", "recwWvBju2ycB63i4", "recQkO6BA4w5zqwZ4"}
    tasks = ([{"fields": {"Approval Outcome": "Approved as-is", "Sent For Approval By": ["rec7aHLK1Q8fMLRXH"]}}] * 13
             + [{"fields": {"Approval Outcome": "Rejected", "Team Member": ["rec7aHLK1Q8fMLRXH"]}}]
             + [{"fields": {"Approval Outcome": "Approved as-is", "Team Member": ["recwWvBju2ycB63i4"]}}] * 27
             # raised by the Builder about an AR matter: the Builder's card, as in facts_handback
             + [{"fields": {"Approval Outcome": "Approved as-is", "Sent For Approval By": ["recQkO6BA4w5zqwZ4"],
                            "Team Member": ["rec7aHLK1Q8fMLRXH"]}}]
             + [{"fields": {"Sent For Approval By": ["rec7aHLK1Q8fMLRXH"]}}]   # not decided yet
             # a card Kevin works himself, left out exactly as facts_handback leaves it out
             + [{"fields": {"Task Name": "RENT CLAIM DECISION Unit 1", "Approval Outcome": "Approved as-is",
                            "Sent For Approval By": ["rec7aHLK1Q8fMLRXH"]}}]
             + [{"fields": {"Task Name": "Chase", "Notes": "RENT FORM KEY: x", "Approval Outcome": "Rejected",
                            "Team Member": ["rec7aHLK1Q8fMLRXH"]}}])
    facts = {"register": register, "rent_row": rent_row, "handback": handback_line(payload, now),
             "last7": last7(tasks, ai), "recon": recon}

    # Worked example 1: Accounts Receivable, the live rent row beats a 47-day-old register reading.
    ar = render("accounts-receivable", facts, now)
    check("AR score is the live rent line", "Score: 58 of 67 tenants paying (86.6%, floor 97.5%), daily rent check 18 Nov 12:39 -> BELOW TARGET" in ar)
    check("AR never shows the stale 96.9%", "96.9" not in ar)
    check("AR target from the register", "Target: Paid occupancy (live tenancies In Payment / live tenancies) 97.5% or above" in ar)
    check("AR hand-back", "Hand-back, 14 days: 0 of 23 cards came back to you (score 100, green)" in ar)
    check("AR last 7 days", "Last 7 days: 14 cards decided: 13 approved as-is, 1 rejected" in ar)
    # Worked example 2: Compliance, an undated reading says so.
    co = render("compliance", facts, now)
    check("Compliance score labelled undated", "59 outstanding (21 expired, 36 missing, 2 undated); 1 due in 30 days (undated reading)" in co)
    check("Compliance hand-back with reasons", "2 of 35 cards came back to you (score 94, amber): " in co and "1 you did an ID check" in co)
    check("Compliance last 7 days", "27 cards decided: 27 approved as-is" in co)
    check("form cards never count as the agent's cards", "RENT" not in ar and "14 cards decided" in ar)
    # Worked example 3: the Bookkeeper, re-measured live.
    v, t = recon_score(recon)
    check("Bookkeeper re-measured", t.startswith("83% (273 of 327 checked, last 31 days); auto-approve slice 96% (107 of 112)"))
    check("Bookkeeper below its 95% target", v == "below target")
    money = render("money-room", facts, now)
    check("Money room lists the Bookkeeper live", "Bookkeeper: 83% (273 of 327" in money and "BELOW TARGET" in money)
    check("Money room pulls in AP and AR", "Accounts Payable:" in money and "Accounts Receivable:" in money)
    check("AP 'since 18 Nov' counts as dated", "(reading dated 18 Nov)" in money)

    # Reading ages
    check("old dated reading labelled", reading_age("6 of 7 nights (9 to 15 Oct 2026)", today)[1] == "reading dated 15 Oct, 34 days old")
    check("newest of several dates wins", reading_age("Last book 23 Aug 2026; none in (10 to 16 Oct 2026)", today)[0] == date(2026, 10, 16))
    check("no date -> undated", reading_age("101 stuck (target 0)", today)[1] == "undated reading")
    check("a yearless future date is last year", reading_age("since 20 Dec", today)[0] == date(2025, 12, 20))
    # Review of 18 Nov 2026: ordinary words are not months, and a planned date is not the reading's.
    dec5 = date(2026, 12, 5)
    check("'3 declined' is not 3 Dec", reading_age("41 of 45 approved, 3 declined (to 12 Oct 2026)", dec5)[1]
          == "reading dated 12 Oct, 54 days old")
    check("'3 declined' alone stays undated", reading_age("40 drafts, 3 declined", dec5)[1] == "undated reading")
    check("'5 marked', '5 may', '12 novel' are not dates",
          reading_age("5 marked, 12 novel, 5 may", today)[1] == "undated reading")
    check("a future dated plan never hides an old reading",
          reading_age("62 of 64 on 2 Oct 2026; next review 30 Nov 2026", today)[1] == "reading dated 2 Oct, 47 days old")
    check("full month names read", reading_age("checked 14 November 2026", today)[0] == date(2026, 11, 14))
    check("leap day without a year never crashes", reading_age("since 29 Feb", date(2028, 2, 10)) == (None, "undated reading")
          and reading_age("since 29 Feb", date(2028, 3, 10))[0] == date(2028, 2, 29))
    check("23 of 40 is 57, as the dashboard", pct(23, 40) == 57)
    check("half rounds up, as the dashboard's Math.round", pct(189, 200) == 95 and recon_score(
        [{"fields": {RA_OK: True}}] * 189 + [{"fields": {}}] * 11)[0] == "on target")

    # Hand-back trust
    check("stale verdict row -> can't tell", handback_line(dict(payload, computedAt="2026-11-18T17:00:00Z"), now)[0] is None)
    check("grey line -> can't tell", handback_line({"computedAt": "2026-11-18T19:50:05Z",
                                                    "lines": [{"key": "handback", "colour": "grey", "why": "x"}]}, now) == (None, "x"))
    check("agent with no cards", handback_text(hb, None, "recNOPE") == "no cards in 14 days")
    check("can't tell carries the why", handback_text(None, "over 2 hours ago", "x") == "can't tell (over 2 hours ago)")

    # Failures are named on their line, never a zero
    bad = dict(facts, tasks_error="Airtable said HTTP 503 for Tasks")
    check("tasks read failure is named", "Last 7 days: unavailable: Airtable said HTTP 503 for Tasks" in render("compliance", bad, now))
    bad = {"register_error": "could not reach Airtable (URLError)", "handback": (None, "x")}
    check("register read failure is named", "Score: unavailable: could not reach Airtable (URLError)" in render("compliance", bad, now))
    check("an unread register never says 'not set'",
          "Target: unavailable: could not reach Airtable (URLError)" in render("compliance", bad, now))
    check("a room names a failed Tasks read", "7 days unavailable" in render(
        "property-room", dict(facts, tasks_error="Airtable said HTTP 503 for Tasks"), now))
    _DEADLINE["at"] = time.monotonic() - 1
    try:
        read_rows("Tasks")
        timed_out = False
    except ReadError as e:
        timed_out = "ran out of time" in str(e)
    finally:
        _DEADLINE["at"] = None
    check("a spent read budget gives 'ran out of time', never a hang", timed_out)
    check("rent row missing falls back to the register, labelled old",
          "62 of 64 paying (96.9%) on 2 Oct 2026, from the first live rent check (reading dated 2 Oct, 47 days old)"
          in render("accounts-receivable", dict(facts, rent_row=None), now))
    check("rent row over a day old is labelled",
          "(over a day old)" in rent_score({"fields": dict(rent_row["fields"], **{"Last Run": "2026-11-16T12:00:00Z"})}, now)[1])
    check("no recon rows -> says so", recon_score([]) == (None, "no reconciliations checked in the last 31 days"))

    # Whole team
    ceo = render("ceo-room", facts, now)
    check("CEO room carries every chat agent", all(CHATS[k]["name"] + ":" in ceo for k in CHATS))
    check("CEO room carries every scheduled agent", all(SCHEDULED[k]["name"] + ":" in ceo for k in SCHEDULED))
    check("CEO room has the team hand-back", "Whole team hand-back, 14 days: 16 of 264 cards came back to you (score 94, amber)" in ceo)
    check("Operations Manager never shortened", "Operations Manager" in ceo and "Operations:" not in ceo)

    # Which chat, and when the hook speaks
    check("env names the chat", chat_key({"OD_AGENT_CHAT": "compliance"}, "/tmp") == "compliance")
    check("folder names the chat", chat_key({}, folder_for("money-room")) == "money-room")
    check("unknown folder -> no chat", chat_key({}, "/tmp") is None)
    check("first message -> due", due({}, now))
    check("an hour later -> not due", not due({"shown": (now - timedelta(hours=1)).isoformat()}, now))
    check("3 hours later -> due", due({"shown": (now - timedelta(hours=3)).isoformat()}, now))
    import tempfile
    global STATE_DIR, PROJECTS_DIR, CHAT_LOGS
    keep, STATE_DIR = STATE_DIR, tempfile.mkdtemp()
    keep_p, PROJECTS_DIR = PROJECTS_DIR, tempfile.mkdtemp()   # never the real saved chats
    keep_l, CHAT_LOGS = CHAT_LOGS, tempfile.mkdtemp()         # never the real brain
    try:
        stdin = json.dumps({"session_id": "s1", "cwd": "/tmp"})
        env = {"OD_AGENT_CHAT": "accounts-receivable"}
        first = cmd_hook(stdin, env, now, lambda k, n: facts)
        second = cmd_hook(stdin, env, now + timedelta(minutes=5), lambda k, n: facts)
        later = cmd_hook(stdin, env, now + timedelta(hours=4), lambda k, n: facts)
        check("hook shows the scorecard on the first message", first.startswith("AGENT CHAT SCORECARD for Accounts Receivable"))
        check("hook is quiet five minutes later", second == "")
        check("hook shows it again after 3 hours", later.startswith("AGENT CHAT SCORECARD"))
        stdin3 = json.dumps({"session_id": "s3"})
        steady = [cmd_hook(stdin3, env, now + timedelta(hours=h), lambda k, n: facts) for h in range(0, 6)]
        check("a steady hour-by-hour chat gets one scorecard, not one every 3 hours",
              bool(steady[0]) and not any(steady[1:]))
        back = cmd_hook(stdin3, env, now + timedelta(hours=8, minutes=1), lambda k, n: facts)
        check("back after 3 hours away -> scorecard again", back.startswith("AGENT CHAT SCORECARD"))
        check("hook outside a chat folder is silent", cmd_hook(stdin, {}, now, lambda k, n: facts) == "")

        def broken(k, n):
            raise RuntimeError("boom")
        msg = cmd_hook(json.dumps({"session_id": "s2"}), env, now, broken)
        check("a broken gather never blocks and says unavailable", "could not be built" in msg and "never guess" in msg)

        # LAST TIME WE SPOKE (Kevin's note, 19 Nov 2026). An invented conversation shaped like the
        # saved chats read on 19 Nov 2026: the app's reminder in a block of its own in front of
        # Kevin's words, the scorecard's code block on top of an answer, a "checking" line before a
        # lookup, the setup prompt, and Claude Code's summary marker and summary.
        def entry(kind, at, content, **kw):
            return json.dumps(dict({"type": kind, "timestamp": at, "message": {"role": kind, "content": content}}, **kw))
        convo = [
            entry("user", "2026-11-18T18:00:00Z",
                  "<system-reminder>\nLinked sessions now\n</system-reminder>\n\n[agent-chats setup] Introduce yourself"),
            entry("assistant", "2026-11-18T18:00:09Z", [{"type": "text", "text": "```\nAccounts Receivable\n```\nI look after rent."}]),
            entry("user", "2026-11-18T19:00:00Z", [{"type": "text", "text": "<system-reminder>\nnote\n</system-reminder>\n\n"},
                                                   {"type": "text", "text": "Who is late at Elm Row?"}]),
            entry("assistant", "2026-11-18T19:00:05Z", [{"type": "text", "text": "Checking the rent row."}]),
            entry("assistant", "2026-11-18T19:00:06Z", [{"type": "tool_use", "name": "Bash", "input": {}}]),
            entry("user", "2026-11-18T19:00:07Z", [{"type": "tool_result", "content": "x"}]),
            entry("assistant", "2026-11-18T19:00:20Z",
                  [{"type": "text", "text": "```\nscore\n```\n\nTwo tenants at Elm Row are late: flat 2 and flat 5.\nMore."}]),
            entry("user", "2026-11-18T19:10:00Z", "Chase flat 5 on Friday"),
            entry("assistant", "2026-11-18T19:10:30Z", [{"type": "text", "text": "**Done**: task raised for Friday."}]),
            json.dumps({"type": "system", "subtype": "compact_boundary", "timestamp": "2026-11-18T19:20:00Z"}),
            entry("user", "2026-11-18T19:20:01Z", "This session is being continued from a previous conversation that ran out "
                  "of context.", isCompactSummary=True),
            entry("user", "2026-11-18T19:30:00Z", "And the void at Oak House?"),
        ]
        exs = exchanges(convo)
        check("recall: the setup prompt and the summary are never Kevin's questions",
              [x["ask"] for x in exs] == ["Who is late at Elm Row?", "Chase flat 5 on Friday", "And the void at Oak House?"])
        check("usage: a reminder in front of Kevin's words no longer hides them, a summary is not his",
              kevin_messages(convo, now - timedelta(days=14))[0] == 3)
        check("recall: the answer is the reply, not the 'checking' line or the scorecard",
              exs[0]["answer"] == "Two tenants at Elm Row are late: flat 2 and flat 5.")
        check("recall: markdown marks are cut from an answer", exs[1]["answer"] == "Done: task raised for Friday.")
        check("recall: a question not answered yet has no answer", exs[2]["answer"] == "")
        check("recall: the summary marker is found", compacted_at(convo) == datetime(2026, 11, 18, 19, 20, tzinfo=timezone.utc))
        check("recall: no summary, no marker", compacted_at(convo[:9]) is None)
        check("a room's brain log is named by its plain name",
              chat_log_path("ceo-room", date(2026, 11, 19)).endswith("2026-11-19 CEO room chat.md"))

        tdir = project_dir(folder_for("accounts-receivable"))
        os.makedirs(tdir)
        tpath = os.path.join(tdir, "s9.jsonl")
        with open(tpath, "w") as fh:
            fh.write("\n".join(convo[:9]) + "\n")   # the chat before Claude Code summarised it

        def hook_in(prompt, sid="s9"):
            return json.dumps({"session_id": sid, "transcript_path": tpath, "prompt": prompt})
        t0 = datetime(2026, 11, 18, 19, 15, tzinfo=timezone.utc)   # after two answers, before the summary
        out1 = cmd_hook(hook_in("How is rent today?"), env, t0, lambda k, n: facts)
        check("recall: the first message gets the scorecard, then LAST TIME WE SPOKE",
              out1.startswith("AGENT CHAT SCORECARD") and "\n\nLAST TIME WE SPOKE (Accounts Receivable chat" in out1)
        check("recall: Kevin's questions come back with the answers he got",
              '"Who is late at Elm Row?" You said: "Two tenants at Elm Row are late: flat 2 and flat 5."' in out1
              and '"Chase flat 5 on Friday" You said: "Done: task raised for Friday."' in out1)
        check("recall: the chat tells Kevin in one line when they last spoke", "Last time we spoke (<day>)" in out1)
        log18 = chat_log_path("accounts-receivable", date(2026, 11, 18))
        with open(log18) as fh:
            body = fh.read()
        check("log: each answered question is one brain line",
              body.count(AUTO_MARK) == 2
              and '- 19:00, Q&A (auto). Kevin: "Who is late at Elm Row?" Answer: "Two tenants at Elm Row are late' in body)
        check("log: a new day's file has its heading and keeps the Links footer last",
              body.startswith("# 2026-11-18 (Wednesday): Accounts Receivable chat\n\n- 19:00, Q&A")
              and "\n- 19:10, Q&A" in body and "\n\n- 19:10" not in body
              and body.rstrip().endswith("Links: [[ceo-conversations-moc]]"))
        check("recall: the hook's own Q&A lines are not shown again as written down",
              "Written down from this chat (brain):\n- nothing written down yet." in out1)
        out2 = cmd_hook(hook_in("ok"), env, t0 + timedelta(minutes=2), lambda k, n: facts)
        with open(log18) as fh:
            check("log: nothing is logged twice", fh.read().count(AUTO_MARK) == 2)
        check("recall: quiet on the next message", out2 == "")
        with open(tpath, "w") as fh:
            fh.write("\n".join(convo) + "\n")      # Claude Code summarised the chat; Kevin carries on
        out3 = cmd_hook(hook_in("And the void at Oak House?"), env, t0 + timedelta(minutes=16), lambda k, n: facts)
        check("recall: after a summary the recall comes back alone, for the agent, not shown to Kevin",
              out3.startswith("LAST TIME WE SPOKE") and "do not show it" in out3 and "SCORECARD" not in out3
              and "Elm Row" in out3)
        check("recall: the message Kevin is sending now is not 'last time'", "Oak House" not in out3)
        out4 = cmd_hook(hook_in("thanks"), env, t0 + timedelta(minutes=20), lambda k, n: facts)
        check("recall: once per summary", out4 == "")

        log17 = chat_log_path("accounts-receivable", date(2026, 11, 17))
        with open(log17, "w") as fh:
            fh.write("# 2026-11-17 (Tuesday): Accounts Receivable chat\n\n"
                     "- 10:00, Kevin agreed flat 5 goes on a payment plan.\n\nLinks: [[ceo-conversations-moc]]\n")
        check("recall: written-down lines come back with their day, Q&A lines left out",
              written_down("accounts-receivable") == [(date(2026, 11, 17), "10:00, Kevin agreed flat 5 goes on a payment plan.")])
        _append_log_line("accounts-receivable", date(2026, 11, 17), "- 11:00, Q&A (auto). Kevin: \"x\" Answer: \"y\"")
        with open(log17) as fh:
            body = fh.read()
        check("log: a line joins an existing file above its Links footer",
              body.index("- 11:00, Q&A") < body.index("Links:") and body.index("- 10:00") < body.index("- 11:00"))
        # The review of 19 Nov 2026, one check per finding, shaped from real saved entries.
        def queued(at, text, kind="human", mode="prompt"):
            return json.dumps({"type": "attachment", "timestamp": at, "attachment": {
                "type": "queued_command", "commandMode": mode, "origin": {"kind": kind}, "prompt": text}})
        busy = [
            entry("user", "2026-11-18T19:00:00Z", "Who is late?"),
            entry("assistant", "2026-11-18T19:00:05Z", [{"type": "text", "text": "Checking the rent row."}]),
            entry("assistant", "2026-11-18T19:00:06Z", [{"type": "tool_use", "name": "Bash", "input": {}}]),
            queued("2026-11-18T19:00:07Z", "Also chase flat 5"),
            entry("user", "2026-11-18T19:00:08Z", [{"type": "tool_result", "content": "x"}]),
            entry("assistant", "2026-11-18T19:00:20Z", [{"type": "text", "text": "Raised a chase for flat 5."}]),
            queued("2026-11-18T19:01:00Z", "<task-notification>done</task-notification>", "task-notification",
                   "task-notification"),
            entry("assistant", "2026-11-18T19:01:05Z", [{"type": "text", "text": "A background job finished."}]),
            entry("user", "2026-11-18T19:02:00Z", "[Request interrupted by user]"),
            entry("user", "2026-11-18T19:03:00Z", "\n\n<pasted_content id=\"a1\">\nRent list for Elm Row\n</pasted_content>"),
            json.dumps({"type": "assistant", "timestamp": "2026-11-18T19:03:05Z", "isApiErrorMessage": True,
                                 "message": {"role": "assistant", "model": "<synthetic>",
                                             "content": [{"type": "text", "text": "API Error: Can't reach the API server"}]}}),
            entry("user", "2026-11-18T19:04:00Z", "Background (from the session that started this one):\nbrief"),
            entry("user", "2026-11-18T19:05:00Z", "<task-notification>x</task-notification>",
                  origin={"kind": "task-notification"}),
        ]
        bx = exchanges(busy)
        check("review 1: a message typed while the agent works is its own question; both share the final reply",
              [(x["ask"], x["answer"]) for x in bx][:2]
              == [("Who is late?", "Raised a chase for flat 5."), ("Also chase flat 5", "Raised a chase for flat 5.")])
        check("review 1: a background notice's reply is never filed as Kevin's answer",
              all("background job" not in x["answer"] for x in bx))
        check("review 5: pasted text is his question; interruptions, briefs and notices are not",
              [x["ask"] for x in bx] == ["Who is late?", "Also chase flat 5", "Rent list for Elm Row"])
        check("review 6: an API error is never the answer", bx[2]["answer"] == "")
        shot = [
            entry("user", "2026-11-18T19:00:00Z", "Who is late?", origin={"kind": "human"}),
            entry("assistant", "2026-11-18T19:00:20Z", [{"type": "text", "text": "Flat 2 is late."}]),
            entry("user", "2026-11-18T19:01:00Z", [{"type": "image", "source": {}}], origin={"kind": "human"}),
            entry("assistant", "2026-11-18T19:01:20Z", [{"type": "text", "text": "That screenshot shows a bank transfer."}]),
            entry("user", "2026-11-18T19:02:00Z", "<system-reminder>only a note</system-reminder>"),
            entry("assistant", "2026-11-18T19:02:20Z", [{"type": "text", "text": "Noted the transfer."}]),
        ]
        sx = exchanges(shot)
        check("second review: a screenshot with no words is a new question, never a new answer to the last one",
              [(x["ask"], x["answer"]) for x in sx]
              == [("Who is late?", "Flat 2 is late."), ("(a screenshot)", "Noted the transfer.")])
        check("review 1: usage counts the queued message too", kevin_messages(busy, now - timedelta(days=14))[0] == 3)
        dup = [{"at": datetime(2026, 11, 16, 9, 0, tzinfo=timezone.utc), "ask": "a", "answer": "b"},
               {"at": datetime(2026, 11, 15, 9, 0, tzinfo=timezone.utc), "ask": "c", "answer": "d"}]
        blocker = chat_log_path("compliance", date(2026, 11, 16))
        os.makedirs(blocker)                      # the 16 Nov file cannot be written
        mark = log_exchanges("compliance", dup, None)
        os.rmdir(blocker)
        mark2 = log_exchanges("compliance", dup, mark)
        mark3 = log_exchanges("compliance", dup, None)   # a run cut off before its marker was saved
        with open(chat_log_path("compliance", date(2026, 11, 15))) as fh:
            d15 = fh.read()
        with open(blocker) as fh:
            d16 = fh.read()
        check("review 2: a failed write keeps the marker of the lines before it, oldest first",
              mark == "2026-11-15T09:00:00+00:00" and mark2 == "2026-11-16T09:00:00+00:00")
        check("review 2: a retry never writes a line twice", d15.count(AUTO_MARK) == 1 and d16.count(AUTO_MARK) == 1
              and mark3 == mark2)
        torn = os.path.join(tdir, "torn.jsonl")
        with open(torn, "wb") as fh:
            fh.write(("\n".join(convo[:9]) + "\n").encode() + '{"type":"user","message":{"content":"caf'.encode()
                     + "é".encode()[:1])
        out7 = cmd_hook(json.dumps({"session_id": "s11", "transcript_path": torn, "prompt": "hi"}), env, now,
                        lambda k, n: facts)
        check("review 3: a character cut in half never costs the scorecard or the recall",
              out7.startswith("AGENT CHAT SCORECARD") and "Elm Row" in out7)
        started = time.time()
        try:
            _within(0.2, time.sleep, 2)
            slow = False
        except TimeoutError:
            slow = time.time() - started < 1
        check("review 4: a stalled brain folder gives up on time", slow)

        CHAT_LOGS = os.path.join(CHAT_LOGS, "missing")
        out5 = recall_block("compliance", now)
        check("recall: an unreadable brain says unavailable, never 'nothing written down'",
              "- unavailable: the brain's CEO Conversations folder could not be read" in out5)
        check("recall: a chat with no saved conversations says none yet", "- none yet: nothing earlier in this chat." in out5)
        out6 = cmd_hook(hook_in("hello", sid="s10"), env, now, lambda k, n: facts)
        check("log: a brain that cannot be written never costs Kevin his message", out6.startswith("AGENT CHAT SCORECARD"))
    finally:
        STATE_DIR, PROJECTS_DIR, CHAT_LOGS = keep, keep_p, keep_l

    # Usage counting for the 14-day review
    since = now - timedelta(days=14)
    lines = [json.dumps(x) for x in [
        {"type": "user", "timestamp": "2026-11-18T19:00:00Z", "message": {"role": "user", "content": "How is rent looking?"}},
        {"type": "user", "timestamp": "2026-11-18T19:01:00Z", "message": {"role": "user", "content": [{"type": "tool_result", "content": "x"}]}},
        {"type": "user", "timestamp": "2026-11-18T19:02:00Z", "message": {"role": "user", "content": "<system-reminder>x</system-reminder>"}},
        {"type": "user", "timestamp": "2026-11-18T18:00:00Z", "message": {"role": "user", "content": "[agent-chats setup] Introduce yourself"}},
        {"type": "user", "timestamp": "2026-11-17T09:00:00Z", "message": {"role": "user", "content": [{"type": "text", "text": "Who is late?"}]}},
        {"type": "user", "timestamp": "2026-10-01T09:00:00Z", "message": {"role": "user", "content": "too old"}},
        {"type": "assistant", "timestamp": "2026-11-18T19:00:05Z", "message": {"role": "assistant", "content": "x"}},
        "not json",
    ]]
    n, days = kevin_messages(lines, since)
    check("usage counts only Kevin's typed messages", n == 2)
    check("usage counts London days", days == ["2026-11-17", "2026-11-18"])
    check("transcript folder encoding", project_dir("/Users/x/Projects/kevin-hq/agents/property/compliance")
          == os.path.join(PROJECTS_DIR, "-Users-x-Projects-kevin-hq-agents-property-compliance"))
    check("every chat has a section", all(spec_for(k)["team"] in TEAMS for k in all_keys()))
    check("12 chats: 7 agents, 4 rooms, the Personal Assistant", len(all_keys()) == 12)
    check("the Personal Assistant has its own folder and section",
          folder_for("personal-assistant").endswith(os.path.join("agents", "personal", "personal-assistant"))
          and chat_key({"OD_AGENT_CHAT": "personal-assistant"}, "/tmp") == "personal-assistant")
    pa = render("personal-assistant", gather("personal-assistant", now), now)
    check("the Personal Assistant has no scorecard and reads nothing", "none" in pa and "show no scorecard block" in pa)
    keep_l, CHAT_LOGS = CHAT_LOGS, tempfile.mkdtemp()   # never the real brain
    keep_p, PROJECTS_DIR = PROJECTS_DIR, tempfile.mkdtemp()   # never the real saved chats
    try:
        pa_recall = recall_block("personal-assistant", now)
    finally:
        CHAT_LOGS, PROJECTS_DIR = keep_l, keep_p
    check("the Personal Assistant gets LAST TIME WE SPOKE with its own log name",
          pa_recall.startswith("LAST TIME WE SPOKE (Personal Assistant chat")
          and chat_log_path("personal-assistant", date(2026, 11, 19)).endswith("2026-11-19 Personal Assistant chat.md"))
    return {"checks": checks, "failed": failed}


def main(argv):
    if not argv:
        print(__doc__.strip().split("Usage:")[1].split("Auth:")[0].rstrip())
        return 1
    cmd = argv[0]
    if cmd == "selftest":
        out = selftest()
        print(json.dumps(out))
        return 1 if out["failed"] else 0
    if cmd == "hook":
        try:
            text = cmd_hook(sys.stdin.read())
        except Exception as e:   # never block Kevin's message
            text = "AGENT CHAT SCORECARD could not be built (%s)." % e.__class__.__name__
        if text:
            print(text)
        return 0
    if cmd == "show":
        key = argv[1] if len(argv) > 1 else None
        if not spec_for(key):
            print("unknown chat %r; one of: %s" % (key, ", ".join(all_keys())), file=sys.stderr)
            return 2
        now = datetime.now(timezone.utc)
        print(render(key, gather(key, now), now))
        return 0
    if cmd == "recall":
        key = argv[1] if len(argv) > 1 else None
        if not spec_for(key):
            print("unknown chat %r; one of: %s" % (key, ", ".join(all_keys())), file=sys.stderr)
            return 2
        print(recall_block(key, datetime.now(timezone.utc)))
        return 0
    if cmd == "usage":
        days = int(argv[argv.index("--days") + 1]) if "--days" in argv else 14
        print(json.dumps(cmd_usage(days), indent=1))
        return 0
    print("unknown command %r" % cmd, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
