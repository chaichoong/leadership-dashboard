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

Usage:
  python3 scripts/agent-scorecard.py hook                 UserPromptSubmit hook (JSON on stdin)
  python3 scripts/agent-scorecard.py show <chat>          print one chat's scorecard
  python3 scripts/agent-scorecard.py usage [--days 14]    Kevin's messages per chat, for the review
  python3 scripts/agent-scorecard.py selftest             offline checks, JSON {checks, failed}
Auth: ~/.config/od/airtable_pat (never printed). Read-only: this file has no write path to Airtable.
"""
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

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

SHOW_AGAIN_HOURS = 3        # a scorecard again after this long away
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
    "ceo-room": dict(name="CEO room", team="whole-team", agent="od-ceo", member="reciHUAEcEkbctnZ6",
                     members=list(CHATS), also=list(SCHEDULED), whole=True),
}
TEAMS = {"property": "Property team", "inbox": "Inbox team", "money": "Money team",
         "runpreneur": "Runpreneur team", "whole-team": "Whole team"}
MONTHS = {m: i for i, m in enumerate(
    ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], 1)}
DATE_RE = re.compile(r"\b(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?(?:\s+(\d{4}))?",
                     re.I)


def all_keys():
    return list(CHATS) + list(ROOMS)


def folder_for(key):
    spec = CHATS.get(key) or ROOMS.get(key)
    return os.path.join(AGENTS_ROOT, spec["team"], key) if spec else None


def chat_key(env=None, cwd=None):
    """Which chat this is: OD_AGENT_CHAT from the folder's settings, else the folder's own name
    when it sits where a chat folder should."""
    env = os.environ if env is None else env
    key = (env.get("OD_AGENT_CHAT") or "").strip()
    if key in CHATS or key in ROOMS:
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
        y = int(year) if year else today.year
        try:
            d = date(y, mon, day)
        except ValueError:
            continue
        if not year and d > today:
            d = date(y - 1, mon, day)
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


def recon_score(rows, target_pct=95):
    """js/reconciliation.js refreshReconAccuracyStats, the same 31-day window and rule."""
    total = len(rows)
    if not total:
        return None, "no reconciliations checked in the last 31 days"
    ok = sum(1 for r in rows if (r.get("fields") or {}).get(RA_OK))
    auto = [r for r in rows if (r.get("fields") or {}).get(RA_SLICE) == "auto-eligible"]
    auto_ok = sum(1 for r in auto if (r.get("fields") or {}).get(RA_OK))
    pct = round(100.0 * ok / total)
    text = "%d%% (%d of %d checked, last 31 days)" % (pct, ok, total)
    if auto:
        text += "; auto-approve slice %d%% (%d of %d)" % (round(100.0 * auto_ok / len(auto)), auto_ok, len(auto))
    text += ", re-measured live"
    return ("below target" if pct < target_pct else "on target"), text


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
        if not outcome:
            continue
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
        if not facts.get("tasks_error"):
            c = (facts.get("last7") or {}).get(member) or {}
            if c:
                parts.append("7 days: %d of %d approved as-is" % (c.get("Approved as-is", 0), sum(c.values())))
    return "  " + " | ".join(parts)


def render(key, facts, now):
    """The whole scorecard block for one chat."""
    stamp = "%s %s" % (short_day(london(now)), london(now).strftime("%H:%M"))
    head = ("AGENT CHAT SCORECARD for %s, read %s London. Show this at the top of your reply, "
            "numbers exactly as given; never round, guess or fill in a line marked unavailable."
            % ((CHATS.get(key) or ROOMS[key])["name"], stamp))
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
    t = _parse_time((state or {}).get("shown"))
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


def read_rows(table, formula=None, fields=None, by_field_id=False):
    """Every matching row, paginated. A reply without a records list is an error, never zero."""
    pat = _token()
    rows, offset = [], None
    for _ in range(200):
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
            with urllib.request.urlopen(req, timeout=20) as resp:
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
    keys = [key] if key in CHATS else ROOMS[key]["members"] + ROOMS[key].get("also", [])
    specs = [CHATS.get(k) or SCHEDULED.get(k) for k in keys]
    facts = {}
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
                              fields=["Approval Outcome", "Sent For Approval By", "Team Member"])
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
    """UserPromptSubmit: the scorecard when it is due, else nothing. Never blocks a prompt."""
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
    if not due(state, now):
        return ""
    try:
        text = render(key, gather_fn(key, now), now)
    except Exception as e:  # a broken scorecard must never cost Kevin his message
        return ("AGENT CHAT SCORECARD for %s could not be built (%s). Tell Kevin in one line that "
                "the scorecard is unavailable; never guess its numbers." % (key, e.__class__.__name__))
    try:
        _write_state(path, {"shown": now.isoformat(), "chat": key})
    except OSError as e:
        text += "\n(scorecard state not saved: %s; it will show again next message)" % e.strerror
    return text


def kevin_messages(lines, since):
    """(count, London days) of Kevin's own typed messages in one transcript: tool results,
    system notices, scheduled runs and the setup prompt that opened the chat do not count."""
    n, days = 0, set()
    for raw in lines:
        try:
            e = json.loads(raw)
        except ValueError:
            continue
        if not isinstance(e, dict) or e.get("type") != "user" or e.get("isSidechain") or e.get("isMeta"):
            continue
        msg = e.get("message") or {}
        content = msg.get("content")
        if isinstance(content, list):
            if any(isinstance(b, dict) and b.get("type") == "tool_result" for b in content):
                continue
            content = " ".join(b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text")
        text = str(content or "").strip()
        if not text or text.startswith("<") or "[agent-chats setup]" in text:
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
        spec = CHATS.get(key) or ROOMS[key]
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
             + [{"fields": {"Sent For Approval By": ["rec7aHLK1Q8fMLRXH"]}}])   # not decided yet
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
    global STATE_DIR
    keep, STATE_DIR = STATE_DIR, tempfile.mkdtemp()
    try:
        stdin = json.dumps({"session_id": "s1", "cwd": "/tmp"})
        env = {"OD_AGENT_CHAT": "accounts-receivable"}
        first = cmd_hook(stdin, env, now, lambda k, n: facts)
        second = cmd_hook(stdin, env, now + timedelta(minutes=5), lambda k, n: facts)
        later = cmd_hook(stdin, env, now + timedelta(hours=4), lambda k, n: facts)
        check("hook shows the scorecard on the first message", first.startswith("AGENT CHAT SCORECARD for Accounts Receivable"))
        check("hook is quiet five minutes later", second == "")
        check("hook shows it again after 3 hours", later.startswith("AGENT CHAT SCORECARD"))
        check("hook outside a chat folder is silent", cmd_hook(stdin, {}, now, lambda k, n: facts) == "")

        def broken(k, n):
            raise RuntimeError("boom")
        msg = cmd_hook(json.dumps({"session_id": "s2"}), env, now, broken)
        check("a broken gather never blocks and says unavailable", "could not be built" in msg and "never guess" in msg)
    finally:
        STATE_DIR = keep

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
    check("every chat has a section", all((CHATS.get(k) or ROOMS[k])["team"] in TEAMS for k in all_keys()))
    check("11 chats", len(all_keys()) == 11)
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
        if key not in CHATS and key not in ROOMS:
            print("unknown chat %r; one of: %s" % (key, ", ".join(all_keys())), file=sys.stderr)
            return 2
        now = datetime.now(timezone.utc)
        print(render(key, gather(key, now), now))
        return 0
    if cmd == "usage":
        days = int(argv[argv.index("--days") + 1]) if "--days" in argv else 14
        print(json.dumps(cmd_usage(days), indent=1))
        return 0
    print("unknown command %r" % cmd, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
