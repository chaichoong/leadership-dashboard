#!/usr/bin/env python3
"""The daily rent check (Kevin, 2 Oct 2026): phase 1 of the Accounts Receivable agent.

WHY THIS IS A SCRIPT AND NOT THE AGENT
The chain map Kevin approved (AI Agents register row reclaAzGLA4utssxx, Notes dated 2026-10-02)
assigns the daily check and the lane sort to simple automation: both are if/then rules, and a
rule is cheaper and steadier than a model. The agent's own links (writing to a tenant, reading a
reply, proposing a payment plan) come in later phases and go through Kevin's approval queue.

WHAT ONE RUN DOES
  1. read     every live tenancy, its tenant, the matched rent payments of the last 80 days, the
              bank feeds of the accounts rent lands in, and money-in still waiting to be matched
  2. judge    each tenancy is paying, paying short, late, or cannot tell
  3. sort     a lane (fine, short, late, new tenant, existing) and a light (green, amber, red, grey)
  4. report   ONE Estate Status row (key rent-position) carrying the line the Home screen prints,
              and one line in the history log so the trial can be checked day by day

WHAT IT NEVER DOES
It sends nothing to a tenant. It writes its own Estate Status row, (lane A, 2 Oct 2026) one RENT
LATE task per late tenancy per stage for the Accounts Receivable agent, (lane B) the tasks that walk
a new tenant into payment, and (3 Oct 2026) AGENT RENT LATE tasks for a late agent-managed rent (the
letting agent collects it, so the letting agent is asked; no tenant is contacted), only while that
agent's register row is Built or Live. Since 16 Nov 2026 that is ONE task per letting agent per due
date per step, listing every unpaid unit (Kevin, 13 Nov 2026: one email covering every unpaid StayCay
property, not one email per property). Its one tenancy write is lane B's: CFV to CFV Actioned with a
comment, after Kevin confirms he sent the direct rent payment form.

LANE A, IN TRIAL (Kevin, 2 Oct 2026)
A tenancy that reads late on trusted bank data becomes a task for the Accounts Receivable agent. The
first task for an owed payment is always the reminder, whenever it is first seen. The follow-up is
raised 3 days after the reminder's task, the firmer message 4 days after the follow-up's (day 0, 3
and 7: the stages in js/cfv.js CFV_CHASE_STAGES). The agent drafts the email, the card goes to Kevin's queue, and
nothing is sent: the agent is a TRIAL agent (scripts/agent_email_format.py TRIAL_AGENTS). No task
is raised for an agent-managed tenancy, an existing void, a void already actioned with the DWP, a
short payment, or anything this check "cannot tell".

LANE B, A NEW TENANT INTO PAYMENT (Kevin, 2 Oct 2026)
scripts/rent_new_tenant.py holds the clock: Roy's journal task, the housing costs check 7 days on,
the form, and a check every 14 days until rent lands. This file calls it after lane A and prints
each tenancy's stage on its row. Before it, scripts/rent_roy_email.py copies Roy's emailed answer to a
housing costs check onto his task's Notes, in the shape lane B already reads as his (9 Oct 2026).

SIGNED AGREEMENTS (9 Oct 2026)
scripts/rent_signed_check.py matches every tenancy agreement Adobe says was signed since 10 Sep 2026 to a
tenancy, and raises ONE TENANCY RECORD task for the Accounts Receivable agent for one with none.

NOT CHASED (Kevin's standing instruction)
A tenant on the private "noChaseTenants" list, or a tenancy on "noChaseTenancies" (both in
PRE_SLATE_PATH, ids only), is judged and shown like anyone else, and no task of either lane is ever
raised for that tenancy. Both lists exist because one person can hold a separate tenant record per
tenancy, so a tenant-id list alone is defeated by a record it does not name.

THE RULE (the app's, js/arrears.js isCurrentlyInArrears, so the robot and the page agree)
A rent cycle is covered when a matched payment linked to the tenancy is dated no more than
EARLY_PAY_DAYS before its due day. The oldest cycle no payment covers is the one owed, and the
tenancy is late once that due day is TOLERANCE_DAYS behind. Five differences from the page, all
deliberate (2 Oct 2026, the last three from the independent review of this build):
  * a due day the month does not have (31 in September, 30 in February) is the month's last day.
    The page lets JavaScript roll it into the next month.
  * the tolerance also holds across a month end. The page checks last month's cycle from the 1st,
    so a due day of 30 was called late on the 1st, one day after it fell due.
  * late is counted from the OLDEST cycle owed, so a second missed month never reads as "2 days".
  * no cycle is owed before the tenancy started.
  * the amount counts. A payment under the rent is "paid short" (amber, still counted as paying),
    and a cash flow void is only cleared by a payment of the full rent. Agent-managed tenancies
    are exempt: they arrive net of fees and in shares, which is correct.

AS AT THE BANK FEED
The bank feed lands about once a day (near 12:00, read from the arrival times on 2 Oct 2026), so a
07:30 run sees money up to about noon the day before. Calling someone late "today" on that data
would cut the two days short. So while a tenancy's rent account has a FRESH feed, lateness is judged
as at that feed's day: the tenancy turns late when the bank data itself covers the two days. The
run is scheduled twice, 07:30 for the morning line and 12:30 to pick up the day's feed.

CANNOT TELL (Kevin's stress tests on the register row)
A late verdict is only as good as the bank data under it, and so is an all-clear. A tenancy whose
rent is overdue by the calendar is reported as "cannot tell", and nobody is called late, when:
its rent account's feed is older than FEED_STALE_HOURS or has no time (a dead feed must never read
as everyone paying); money-in on a rent account that could be its payment is still waiting to be
matched; or many tenancies turn late in the same run, which is what payments not yet in or not yet
matched look like. A read that returns too few rows fails the whole run loudly.

EXISTING ARREARS (Kevin, 2 Oct 2026: "wipe the slate clean, and start from now")
The tenancies already a cash flow void on the slate date are listed in a private file on the Mac
(PRE_SLATE_PATH, never the repo: this repo is public). While they stay a cash flow void they are
shown and counted, and labelled "existing, left alone".

KNOWN LIMITS (accepted for the trial, to be measured in the parallel run)
  * A payment made late can read as the next cycle's early payment (the page's rule too).
  * Rent matched to a category with no Tenancy link is invisible to this check.
  * The surge guard remembers who was already late from the history log on this Mac. With no log
    it can report an already-late tenancy as "cannot tell" for a day: the safe direction.

Usage:
  rent-check.py run [--dry-run]    the daily pass (--dry-run: compute and print, write nothing)
  rent-check.py status             the same result, computed and printed, never written
Auth: ~/.config/od/airtable_pat (never printed).
"""

import argparse
import calendar
import json
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
import rent_cap  # noqa: E402
import rent_new_tenant as lane_b_rules  # noqa: E402
import rent_form_chase  # noqa: E402
import rent_plans  # noqa: E402
import rent_proof_of_residency  # noqa: E402
import rent_roy_email  # noqa: E402
import rent_signed_check  # noqa: E402
import text_check  # noqa: E402
from agent_email_format import (NIL_STATEMENT_SENTENCE, NIL_WITHDRAWN_SENTENCE, NIL_MARK_RE,  # noqa: E402
                                nil_statement_dates)

LONDON = ZoneInfo("Europe/London")
BASE = "appnqjDpqDniH3IRl"
PAT_PATH = os.path.expanduser("~/.config/od/airtable_pat")
HISTORY = os.path.expanduser("~/knowledge-os/logs/rent-check/history.jsonl")

# ─── tables and fields (ids, so a rename in Airtable cannot silently blank a read) ───
T_TENANCIES, T_TENANTS = "tblN51a88qTDB6iMH", "tblX4elTuu01gwBYh"
T_TX, T_ACCOUNTS, T_ESTATE = "tbln0gzhCAorFc3zB", "tbl1nr0EcX2T62KME", "tblZVrdzivyBueZVf"
T_TASKS, T_REGISTER = "tblqB8b22hKBL4PF1", "tbl9msVjyQWslLOIZ"
TY = {"rent": "fldDMyfZLFMeONPq8", "dueDay": "fldhy2U0CQmM2oS4P", "payStatus": "fldxU3dPUnbK0SCDq",
      "start": "fld2rPXwwV8dXb1zF", "end": "fldwHhhKAq4f1nY9e", "tenants": "fld1i5bDoHL3B6rUf",
      "tenantStatus": "fldgWAyha1Uij1SZP", "unitRef": "fldql2nyQlPfkPP4p", "hasTx": "fldQpk89SnnMLCpxa",
      "surname": "fldOXazTqBWieEOK2",
      # Rent Set-off From / Until (9 Oct 2026): the window of rent a letting agent keeps against a bill we owe them.
      # Kevin, 6 Oct 2026: that rent is PAID, not a cash flow void. Written only by scripts/tenancy-record.py.
      "setOffFrom": "fldkeJL4wXDcO6wqq", "setOffUntil": "fldwvF3MrJXlQMoCk"}
# Tenant Name: on an agent-managed tenancy the tenant record IS the letting agent, so its name heads the batched
# AGENT RENT LATE task (16 Nov 2026). Same id as scripts/rent_new_tenant.py TENANT_NAME_FIELD.
TN = {"payType": "fldZbrk8Xw5Dcwxhi", "name": "fldxBKW7QnujSDWqA"}
TX = {"date": "fldoyQ6Rr9cHp3bgQ", "tenancy": "fldPmAMmxwqs4SdPa", "amount": "fldot7iisZeL3WrdR",
      "account": "fld9hm24JQUPOCoWj"}
AC = {"alias": "fld21HAxSawQCxICj", "updated": "fld8HOlbBrXbHesoA"}
TK = {"name": "fldgFjGBw6bTKJFCD", "status": "fldx4qCw17UfrKpaN", "due": "fld7XP8w8kbxfETV4",
      "teamMember": "flduCtmQGpOA4eWaj", "description": "fldRGhBQViKZKtkQ6", "notes": "fldR7apBzSp3oxFxz",
      "tenancies": "fldmne4RYJU22ICub", "tenants": "fld6ZcfEogJmeQj2c"}
ES = {"key": "fldLO6xJqkokvVR4g", "kind": "fldfjQOn76VpgKEfZ", "label": "fldlnvvTh8l5UIih4",
      "schedule": "fldZGa0UD76lVLww7", "status": "fldhOUiva3bqPNk1c", "lastRun": "flduxV3TYwp9wQX9O",
      "lastWorked": "fldMIx3kWMM23vDBN", "detail": "fldLRFP2nJttDVQOa", "payload": "fldiqs9lvyLimoR7i",
      "updated": "fld3q8WN5XqrER92Z"}

# ─── the rules ───────────────────────────────────────────────────────
# Not the job's name: scripts/estate-status.py keeps a JOB row keyed rent-check and would overwrite this one.
STATUS_KEY = "rent-position"
TOLERANCE_DAYS = 2          # js/arrears.js isCurrentlyInArrears `tolerance` and js/cfv.js CFV_TOLERANCE_DAYS
EARLY_PAY_DAYS = 5          # js/arrears.js EARLY_PAY_DAYS
RED_AFTER_DAYS = 7          # late this long turns amber to red
SHORT_SLACK = 1.00          # pounds under the rent that still count as the full rent
WAITING_SHARE = 0.25        # unmatched money-in this share of the rent or more could be the rent
LATE_BEFORE_DAYS = 3        # a history line older than this says nothing about who was late yesterday
FLOOR_PCT = 97.5            # Kevin, 2 Oct 2026: "always 97.5% and above, as an absolute minimum"
FEED_STALE_HOURS = 36
# This many tenancies turning late in one run is what payments not yet in, or not yet matched, look
# like, not a rent strike: they are reported as "cannot tell" (stress test 3 on the register row).
# Tenancies that were already late before the surge stay late.
MASS_LATE_SHARE, MASS_LATE_MIN = 0.25, 10
BRIEF_NAMES_MAX = 5         # units named per group in the Home line; the rest are a count
TX_LOOKBACK_DAYS = 80       # two full cycles plus the early-payment window
# Private, on the Mac that runs the job (STRUCTURE.md, the scripts row).
PRE_SLATE_PATH = os.path.expanduser("~/.config/od/rent-check-pre-slate.json")
# Lane A. The agent's Team Members row and register row: kept identical to RENT_REC_ID and
# RENT_REGISTER_ROW in scripts/agent-dispatch.py (tests/cash-flow-voids-agent.test.js).
AGENT_TEAM_MEMBER, REGISTER_ROW, REGISTER_STATUS = "rec7aHLK1Q8fMLRXH", "reclaAzGLA4utssxx", "fld71vXWqcxhdljac"
# No "void" in the name: scripts/agent-dispatch.py reads that word as Roy's lane.
TASK_PREFIX, KEY_MARK = "RENT LATE: ", "RENT CHECK KEY: "
# The stages of one chase (js/cfv.js CFV_CHASE_STAGES: day 0, day 3, day 7), and the days that must
# pass after a stage's task was raised before the next one is.
STAGES = {1: "reminder", 2: "follow-up", 3: "firmer message"}
STAGE_GAP_DAYS = {1: 3, 2: 4}
IN_PAYMENT, CFV, CFV_ACTIONED = "In Payment", "CFV", "CFV Actioned"
AGENT_MANAGED = "Agent-Managed"
# A LATE AGENT-MANAGED RENT: the letting agent collects it, so no tenant is contacted. Since 5 Oct 2026 (Kevin:
# "Roy only gets escalations for things that we can't physically do. Anything administrative, the AI agent can
# do.") the Accounts Receivable agent emails the letting agent, twice at most, and Roy phones them only after that
# (agent_late_plan). Before, Roy got every one (3 Oct 2026). Since 16 Nov 2026 one task covers every unpaid unit of
# one letting agent with the same due date at the same step; it carries one key line per unit (agent_late_plan).
AGENT_LATE_PREFIX, AGENT_LATE_MARK = "AGENT RENT LATE: ", "RENT AGENT KEY: "
AGENT_CHASE_DAYS, AGENT_ROY_DAYS = 3, 4     # second email 3 days after the first went; Roy 4 days after the second
# Zero rows from any of these is a broken read, not an empty business (64 live tenancies, 35 active
# tenants, 150 matched rent payments in 80 days and 2 rent accounts were read on 2 Oct 2026).
FLOORS = (("tenancies", 20), ("tenants", 20), ("tx", 20), ("accounts", 1))
LIVE_FLOOR = 20             # fewer live tenancies judged than this is a broken read too


# ─── small helpers ───────────────────────────────────────────────────
def today_london():
    return datetime.now(LONDON).date()


def parse_day(v):
    try:
        return date.fromisoformat(str(v)[:10])
    except ValueError:
        return None


def sel(v):
    """A single select arrives as its name, or as {name: ...} from some read paths."""
    if isinstance(v, dict):
        return str(v.get("name") or "")
    return str(v or "")


def first(v):
    return v[0] if isinstance(v, list) and v else (v if not isinstance(v, list) else "")


def due_on(year, month, due_day):
    """The due date in a month, with a due day the month lacks falling on its last day."""
    return date(year, month, min(due_day, calendar.monthrange(year, month)[1]))


def prev_due(due, due_day):
    year, month = (due.year, due.month - 1) if due.month > 1 else (due.year - 1, 12)
    return due_on(year, month, due_day)


def next_due(due, due_day):
    year, month = (due.year, due.month + 1) if due.month < 12 else (due.year + 1, 1)
    return due_on(year, month, due_day)


def first_uncovered(newest, start, day, due_day):
    """The due date of the oldest rent cycle no payment covers. It may lie in the future.

    A payment covers every cycle due up to EARLY_PAY_DAYS after it. Nothing is owed before the
    tenancy started, and nothing is looked for beyond the payments this run read."""
    floor = max(start, day - timedelta(days=TX_LOOKBACK_DAYS))
    if newest:
        floor = max(floor, newest + timedelta(days=EARLY_PAY_DAYS + 1))
    due = due_on(floor.year, floor.month, due_day)
    return due if due >= floor else next_due(due, due_day)


# A LETTING AGENT'S NIL STATEMENT (finding 1354, 19 Nov 2026). An agent-managed rent is paid by the letting agent, net
# of fees, after the tenant pays them. When the agent's statement for a month shows no payout, nothing was due to us on
# that due date, so the rent check must not count it as owed (23 Viola Street read 39 days late on 18 Nov 2026 while the
# real gap was 8: StayCay's September statement, emailed 8 Oct, showed a 0.00 payout). The fact is written once, as a
# dated comment on the tenancy, by `tenancy-record.py nil-statement` (the agent's own written figure, quoted), and read
# back here. Agent-managed tenancies only: anything else's comment is ignored.
# The comment's shape, its reader (nil_statement_dates) and the withdrawal are shared with the AGENT RENT LATE send,
# in agent_email_format.py (imported above), so the rent check and the send can never disagree on a nil month.
NIL_STATEMENT_MARK = "NIL STATEMENT "


def read_comments(tenancy_id):
    """Every comment on one tenancy, following offset."""
    out, offset = [], None
    while True:
        params = {"pageSize": 100, **({"offset": offset} if offset else {})}
        page = api("GET", f"{T_TENANCIES}/{tenancy_id}/comments", params=params)
        if not isinstance(page, dict) or not isinstance(page.get("comments"), list):
            raise RuntimeError(f"the comments read for {tenancy_id} returned no comments list")
        out += page.get("comments") or []
        offset = page.get("offset")
        if not offset:
            return out


def read_nil_statements(tenancies, tenants, day):
    """({tenancy id: {nil due dates}}, {tenancy ids whose comments could not be read}) for the live agent-managed
    tenancies. One paginated comments read each. A read that fails is named, never read as "no nil statement"."""
    by_tenant = {r["id"]: r.get("fields") or {} for r in tenants}
    found, unchecked = {}, set()
    for rec in tenancies:
        f = rec.get("fields") or {}
        if not is_live(f, day) or tenant_type(f, by_tenant) != AGENT_MANAGED:
            continue
        try:
            dates = nil_statement_dates(read_comments(rec["id"]))
        except Exception:                            # noqa: BLE001 — said on the row as NOT CHECKED, never a pass
            unchecked.add(rec["id"])
            continue
        if dates:
            found[rec["id"]] = dates
    return found, unchecked


def set_off_window(f):
    """(from, until) of rent paid by set-off, or None. Both dates are needed and from must not be after until: a
    half-written window covers nothing (independent review, 9 Oct 2026)."""
    start, until = parse_day(f.get(TY["setOffFrom"])), parse_day(f.get(TY["setOffUntil"]))
    return (start, until) if start and until and start <= until else None


def parse_stamp(stamp):
    try:
        return datetime.fromisoformat(str(stamp).replace("Z", "+00:00"))
    except ValueError:
        return None


def money(v):
    return f"£{v:,.2f}"


# ─── Airtable ────────────────────────────────────────────────────────
def _pat():
    with open(PAT_PATH) as fh:
        return fh.read().strip()


def field_choices(table, field_id):
    """The choice names of a select field, read from the base's schema: the control on a formula that matches a
    choice by name (a renamed choice would match nothing and read as "nobody", never as an error)."""
    tables = (api("GET", f"meta/bases/{BASE}/tables") or {}).get("tables") or []
    for t in tables:
        if t.get("id") == table:
            for f in t.get("fields") or []:
                if f.get("id") == field_id:
                    return [c.get("name") for c in (f.get("options") or {}).get("choices") or []]
    raise RuntimeError(f"control failed: field {field_id} is not in table {table}")


def api(method, path, payload=None, params=None):
    # A schema read ("meta/...") sits outside the base's own path.
    url = f"https://api.airtable.com/v0/{path if path.startswith('meta/') else BASE + '/' + path}"
    if params:
        url += "?" + urllib.parse.urlencode(params, doseq=True)
    data = json.dumps(payload).encode() if payload is not None else None
    for attempt in range(4):
        req = urllib.request.Request(url, data=data, method=method, headers={
            "Authorization": f"Bearer {_pat()}", "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < 3:
                time.sleep(1.5 * (attempt + 1))
                continue
            # Never echo headers: they carry the PAT.
            raise RuntimeError(f"Airtable {method} {path.split('?')[0]} {e.code}: {e.read().decode()[:300]}")


def fetch_all(table, params=None):
    out, offset = [], None
    while True:
        p = dict(params or {})
        p["returnFieldsByFieldId"] = "true"
        p["pageSize"] = 100
        if offset:
            p["offset"] = offset
        d = api("GET", table, params=p)
        out += d.get("records", [])
        offset = d.get("offset")
        if not offset:
            return out


def check_controls(data):
    """The silent-zero trap: a read that comes back near empty is broken, and must stop the run."""
    for key, floor in FLOORS:
        if len(data.get(key) or []) < floor:
            raise RuntimeError(f"control failed: {key} read returned {len(data.get(key) or [])} rows "
                               f"(expected {floor}+); the read is broken, not the business empty")


def read_pre_slate(path=None):
    """The cash flow voids that existed on the slate date. Unreadable or the wrong shape stops the
    run: without it an existing void would be reported as a new late payer. An empty list is valid."""
    try:
        with open(path or PRE_SLATE_PATH) as fh:
            ids = json.load(fh)["tenancies"]
        if not isinstance(ids, list) or not all(isinstance(i, str) and i.startswith("rec") for i in ids):
            raise ValueError("'tenancies' must be a list of record ids")
    except (OSError, ValueError, KeyError, TypeError) as exc:
        raise RuntimeError(f"control failed: the list of existing cash flow voids could not be read ({exc})")
    return set(ids)


def read_no_chase(path=None, key="noChaseTenants"):
    """The tenants no task is ever raised for (Kevin's standing instruction), from the same private
    file. The key is optional: a file without it is an empty list. The wrong shape stops the run,
    because reading it as empty would chase someone Kevin said to leave alone.

    `key` picks the list: "noChaseTenants" (tenant ids) or "noChaseTenancies" (tenancy ids). One
    person can hold a separate tenant record per tenancy, so a tenant-id list is defeated by a
    duplicate record the list does not name (9 Nov 2026, finding 20261109-agent-dispatch-1253: five
    records for one tenant, one of them on the list, and the other four chased). A tenancy id cannot
    be defeated that way, so both lists are read and either one spares a tenancy."""
    try:
        with open(path or PRE_SLATE_PATH) as fh:
            ids = json.load(fh).get(key, [])
        if not isinstance(ids, list) or not all(isinstance(i, str) and i.startswith("rec") for i in ids):
            raise ValueError(f"'{key}' must be a list of record ids")
    except (OSError, ValueError, AttributeError, TypeError) as exc:
        raise RuntimeError(f"control failed: the list of tenants not to chase could not be read ({exc})")
    return set(ids)


def check_no_chase(data):
    """Every id on either do-not-chase list must be a record this run read: a tenant id on
    noChaseTenants, a tenancy id on noChaseTenancies. An id in the wrong list, or a record since
    deleted, matches nobody and would let that tenant be chased in silence."""
    for key, source, kind in (("noChase", "tenants", "tenant"), ("noChaseTenancies", "tenancies", "tenancy")):
        known = {r["id"] for r in data.get(source) or [] if isinstance(r, dict)}
        stray = sorted(set(data.get(key) or ()) - known)
        if stray:
            name = "noChaseTenants" if kind == "tenant" else "noChaseTenancies"
            raise RuntimeError(f"control failed: {len(stray)} id{'' if len(stray) == 1 else 's'} on the do-not-chase "
                               f"list ({name}) matched no {kind}; that list takes {kind} ids")


def read_late_before(day, path=None):
    """The tenancies the last recorded run called late, so a surge never swallows them. No log, a
    damaged one, or a last run more than LATE_BEFORE_DAYS old is an empty set: the surge may then
    hold an already-late tenancy at "cannot tell", which is the safe direction."""
    try:
        with open(path or HISTORY) as fh:
            lines = [ln for ln in fh.read().splitlines() if ln.strip()]
        last = json.loads(lines[-1])
        if (day - date.fromisoformat(last["day"])).days > LATE_BEFORE_DAYS:
            return set()
        return {tid for tid, lane in (last.get("lanes") or {}).items() if lane == "late"}
    except (OSError, ValueError, IndexError, KeyError, AttributeError, TypeError):
        return set()


def load(day):
    """Everything the check reads, once. Formulas use field NAMES, so a renamed field is an Airtable
    error and never zero rows: that error is the control on the unmatched read, whose honest answer is often zero."""
    since = (day - timedelta(days=TX_LOOKBACK_DAYS)).isoformat()
    data = {
        "tenancies": fetch_all(T_TENANCIES, {"fields[]": list(TY.values())}),
        "tenants": fetch_all(T_TENANTS, {"fields[]": list(TN.values())}),
        "tx": fetch_all(T_TX, {"fields[]": list(TX.values()),
                               "filterByFormula": f"AND({{Reconciled}}, {{Tenancy}}!='', IS_AFTER({{**Date}}, '{since}'))"}),
        "unmatched": fetch_all(T_TX, {"fields[]": list(TX.values()),
                                      "filterByFormula": f"AND(NOT({{Reconciled}}), {{Report Amount}}>0, IS_AFTER({{**Date}}, '{since}'))"}),
        "accounts": fetch_all(T_ACCOUNTS, {"fields[]": list(AC.values())}),
        "preSlate": read_pre_slate(),
        "noChase": read_no_chase(),
        "noChaseTenancies": read_no_chase(key="noChaseTenancies"),
        "lateBefore": read_late_before(day),
    }
    check_controls(data)
    check_no_chase(data)
    data["nilDues"], data["nilUnchecked"] = read_nil_statements(data["tenancies"], data["tenants"], day)
    return data


# ─── the judgement ───────────────────────────────────────────────────
def payments_by_tenancy(tx):
    out = {}
    for rec in tx:
        f = rec.get("fields") or {}
        day = parse_day(f.get(TX["date"]))
        if not day:
            continue
        for tid in f.get(TX["tenancy"]) or []:
            out.setdefault(tid, []).append({"day": day, "amount": float(f.get(TX["amount"]) or 0),
                                            "account": first(f.get(TX["account"]))})
    return out


def feed_state(data, pay, now):
    """What the bank data can support today: per rent account, the day its feed runs to and why it
    cannot be trusted (if it cannot), plus the money-in on those accounts still waiting to be matched."""
    rent_accounts = {p["account"] for ps in pay.values() for p in ps if p["account"]}
    by_id = {r["id"]: r.get("fields") or {} for r in data["accounts"]}
    accounts, feeds, oldest = {}, [], None
    for aid in sorted(rent_accounts):
        f = by_id.get(aid) or {}
        name = str(f.get(AC["alias"]) or "an unnamed account")
        at = parse_stamp(f.get(AC["updated"]))
        age = None if at is None else (now - at).total_seconds() / 3600
        feeds.append({"account": name, "hours": None if age is None else round(age, 1)})
        why = None
        if at is None:
            why = f"{name} has no bank feed time"
        elif age > FEED_STALE_HOURS:
            why = f"{name} bank feed last updated {round(age)} hours ago"
        accounts[aid] = {"day": at.astimezone(LONDON).date() if at else None, "why": why}
        if at and (oldest is None or at < oldest):
            oldest = at
    waiting = []
    for r in data["unmatched"]:
        f = r.get("fields") or {}
        day = parse_day(f.get(TX["date"]))
        if day and first(f.get(TX["account"])) in rent_accounts:
            waiting.append({"day": day, "amount": float(f.get(TX["amount"]) or 0)})
    blocked = [a["why"] for a in accounts.values() if a["why"]]
    if not rent_accounts:
        blocked.append("no rent account could be worked out from the matched payments")
    return {"accounts": accounts, "blocked": blocked, "feeds": feeds, "waiting": waiting,
            "asAt": oldest.astimezone(LONDON).strftime("%-d %b %H:%M") if oldest else ""}


def bank_view(feed, payments):
    """The feed day and the faults of the accounts THIS tenancy's rent arrives in. A tenancy with no
    payment read could be paid into any rent account, so it takes the oldest feed and every fault."""
    mine = {p["account"] for p in payments if p["account"] in feed["accounts"]} or set(feed["accounts"])
    if not mine:
        return None, list(feed["blocked"])
    why = [feed["accounts"][a]["why"] for a in sorted(mine) if feed["accounts"][a]["why"]]
    days = [feed["accounts"][a]["day"] for a in mine]
    return (min(days) if all(days) else None), why


def cycle_money(payments, cycle, due_day):
    """What arrived for one rent cycle: payments from EARLY_PAY_DAYS before its due day up to the
    same point before the next one."""
    lo = cycle - timedelta(days=EARLY_PAY_DAYS)
    hi = next_due(cycle, due_day) - timedelta(days=EARLY_PAY_DAYS)
    return sum(p["amount"] for p in payments if lo <= p["day"] < hi)


def short_by(payments, cycle, rent, start, due_day):
    """What arrived for a rent cycle when it is under the rent, else None. Money paid more than
    EARLY_PAY_DAYS ahead lands in the cycle before, so that cycle is weighed with it when the
    tenancy was already running."""
    one = cycle_money(payments, cycle, due_day)
    if one >= rent - SHORT_SLACK:
        return None
    before = prev_due(cycle, due_day)
    if before >= start and one + cycle_money(payments, before, due_day) >= 2 * rent - SHORT_SLACK:
        return None
    return one


def tenant_type(f, tenants):
    for tid in f.get(TY["tenants"]) or []:
        name = sel((tenants.get(tid) or {}).get(TN["payType"])).lower()
        if "universal credit" in name:
            return "Universal Credit"
        if "agent" in name:
            return AGENT_MANAGED
        if "working" in name:
            return "Working"
    return ""


def is_live(f, day):
    """Not ended, and not a former tenant's. Mirrors js/shared.js isTenancyEnded and isTenantStatusFormer."""
    end = parse_day(f.get(TY["end"]))
    if end and end < day:
        return False
    statuses = f.get(TY["tenantStatus"])
    statuses = statuses if isinstance(statuses, list) else [statuses]
    names = {str(s or "").strip().lower() for s in statuses}
    return not ("former" in names and "active" not in names)


def judge(rec, tenants, payments, day, feed, pre_slate, late_before, nil=(), nil_unchecked=False):
    """One tenancy's row. `nil` holds the due dates a letting agent's statement showed no payout for (agent-managed
    rents only); `nil_unchecked` says that tenancy's comments could not be read, so a nil month may be counted owed."""
    said = []
    row = _judge(rec, tenants, payments, day, feed, pre_slate, late_before, nil, said)
    if nil_unchecked and row.get("type") == AGENT_MANAGED:
        # Overstating is the safe direction: the row is judged as before, and says so.
        said.append("nil statements NOT CHECKED")
    if said:
        row["note"] = f"{row['note']}; {'; '.join(said)}"
    return row


def _judge(rec, tenants, payments, day, feed, pre_slate, late_before, nil, said):
    f = rec.get("fields") or {}
    status = sel(f.get(TY["payStatus"]))
    # A live tenancy can sit unlinked from a unit (Kevin, 1 Oct 2026), so the surname stands in.
    unit = first(f.get(TY["unitRef"])) or f"{f.get(TY['surname']) or rec['id']} (no unit linked)"
    row = {"id": rec["id"], "unit": str(unit), "status": status,
           "type": tenant_type(f, tenants), "rent": float(f.get(TY["rent"]) or 0), "paying": False}
    rent = row["rent"]
    start = parse_day(f.get(TY["start"]))
    try:
        due_day = int(sel(f.get(TY["dueDay"])) or 0)
    except ValueError:
        due_day = 0
    gaps = [w for w, missing in (("due day", not 1 <= due_day <= 31), ("rent amount", rent <= 0),
                                 ("start date", not start), ("linked tenant", not f.get(TY["tenants"]))) if missing]
    if gaps:
        return dict(row, light="grey", lane="unknown", note="cannot tell: the tenancy has no " + ", no ".join(gaps))

    newest = max((p["day"] for p in payments), default=None)
    owed = first_uncovered(newest, start, day, due_day)
    # Rent paid by set-off (Kevin, 6 Oct 2026): only when the oldest unpaid rent falls due INSIDE the window. Rent owed
    # before the window began is still owed, and the first rent after it is judged as usual.
    set_off = set_off_window(f)
    # A letting agent's nil statement (finding 1354): nothing was due to us on that due date, so it is not owed. One
    # loop with the set-off, until neither moves owed (review of the first draft: a nil month just before a set-off
    # window read as late, because the window was checked only once, before the nil skip).
    agent = row["type"] == AGENT_MANAGED
    covered, skipped = False, []
    while True:
        if set_off and set_off[0] <= owed <= set_off[1]:
            covered = True
            owed = next_due(owed, due_day)
        elif agent and owed in nil:
            skipped.append(owed)
            owed = next_due(owed, due_day)
        else:
            break
    if skipped:
        said.append("nil statement for " + ", ".join(d.strftime("%-d %b") for d in skipped))
    if agent and nil:
        # Read by agent_late_plan, so the letting agent's email never counts a nil month as owed.
        row["nilDues"] = sorted(d.isoformat() for d in nil)
    as_at, bank_why = bank_view(feed, payments)
    # With a fresh feed, everything is judged as at the feed's day (never a day ahead of today).
    # With a stale or missing one the calendar decides whether rent is overdue, and an overdue
    # tenancy becomes "cannot tell" below: a dead feed must never read as everyone paying.
    trusted = as_at is not None and not bank_why
    ref = min(as_at, day) if trusted else day
    since_owed = (ref - owed).days
    late = since_owed >= TOLERANCE_DAYS
    days_late = (day - owed).days
    # Nothing matched in the whole window, on a tenancy older than the window: the true count is unknown.
    beyond = newest is None and start < day - timedelta(days=TX_LOOKBACK_DAYS)
    last = (f"last matched payment {newest.strftime('%-d %b')}" if newest
            else f"no matched payment in the last {TX_LOOKBACK_DAYS} days")
    # The newest cycle the bank data has fully covered: the amount is judged on that one, never on
    # rent not yet due. None while no cycle has fallen due since the tenancy began.
    cycle = prev_due(owed, due_day)
    if (ref - cycle).days < TOLERANCE_DAYS:
        cycle = prev_due(cycle, due_day)
    judged = newest is not None and not late and cycle >= start
    # An agent-managed rent arrives net of fees and in shares, so its amount is not weighed.
    got = short_by(payments, cycle, rent, start, due_day) if judged and row["type"] != AGENT_MANAGED else None
    part = "" if got is None else f"{money(got)} of {money(rent)}"

    def cannot_tell():
        """Why an overdue tenancy cannot be called late today, or nothing."""
        why = list(bank_why)
        mine = [w for w in feed["waiting"] if w["day"] >= owed - timedelta(days=EARLY_PAY_DAYS)
                and w["amount"] >= WAITING_SHARE * rent]
        if mine:
            why.append(f"{len(mine)} payment{'s' if len(mine) != 1 else ''} into the rent accounts "
                       f"({money(sum(w['amount'] for w in mine))}) not matched yet")
        return "cannot tell: " + "; ".join(why) if why else ""

    # Paying by set-off while the first rent after the window is not yet late. Never weighed as short or full: no
    # money moved.
    if covered and not late:
        still = f", still marked {status}" if status in (CFV, CFV_ACTIONED) else ""
        return dict(row, light="green", lane="fine", paying=True, setOff=set_off[1].isoformat(),
                    note=f"rent paid by set-off until {set_off[1].strftime('%-d %b %Y')} ({last}){still}")
    if status in (CFV, CFV_ACTIONED):
        word = "cash flow void actioned" if status == CFV_ACTIONED else "cash flow void"
        if judged and got is None:
            # Never "paid in full" for lane C while the tenancy is still marked a cash flow void (review, 5 Oct 2026).
            return dict(row, light="green", lane="fine", paying=True, listed=True,
                        note=f"paid in full ({last}), still marked {word}")
        light = "amber" if status == CFV_ACTIONED else "red"
        extra = f", part payment {part}" if part else ""
        if rec["id"] in pre_slate:
            return dict(row, light=light, lane="existing", note=f"{word}, existing, left alone{extra}")
        if not late and (not payments and not f.get(TY["hasTx"]) or cycle < start):
            # No rent has fallen due since the tenancy began: amber, nothing is owed yet.
            return dict(row, light="amber", lane="new", note=f"new tenant not in payment yet, day {(day - start).days}, "
                                                                f"first rent due {owed.strftime('%-d %b')}, {word}")
        if not payments and not f.get(TY["hasTx"]):
            return dict(row, light=light, lane="new", note=f"new tenant not in payment yet, day {(day - start).days}, "
                                                              f"first rent due {owed.strftime('%-d %b')}, {word}")
        if late and cannot_tell():
            return dict(row, light="grey", lane="unknown", bank=True, note=cannot_tell())
        return dict(row, light=light, lane="late", owed=owed.isoformat(), note=f"{word}, {last}{extra}",
                    **({"daysLate": days_late} if late else {}))
    if status != IN_PAYMENT:
        return dict(row, light="grey", lane="unknown", note=f"cannot tell: payment status is '{status or 'blank'}'")
    if late:
        if cannot_tell():
            return dict(row, light="grey", lane="unknown", bank=True, note=cannot_tell())
        if beyond:
            return dict(row, light="red", lane="late", owed=owed.isoformat(), beyond=True, note=last)
        return dict(row, light="red" if days_late >= RED_AFTER_DAYS else "amber", lane="late", daysLate=days_late,
                    owed=owed.isoformat(),
                    fresh=since_owed <= TOLERANCE_DAYS + 1 and rec["id"] not in late_before,
                    note=f"late {days_late} day{'s' if days_late != 1 else ''}, due {owed.strftime('%-d %b')}, {last}")
    # Paid short is only said on a trusted feed.
    if got is not None and trusted:
        # The cycle rides on the row: lane C raises one benefit-cap task per short cycle (scripts/rent_cap.py).
        return dict(row, light="amber", lane="short", paying=True, got=got, cycle=cycle.isoformat(),
                    note=f"paid short: {part}, {last}")
    # Paid in full is said only of a rent cycle weighed on a trusted feed (lane C's full-payer claim reads it).
    return dict(row, light="green", lane="fine", paying=True, full=bool(judged and got is None and trusted),
                note=last if newest else f"first rent due {owed.strftime('%-d %b')}")


def assess(data, day, now):
    """The whole result for one day, from already-read records. No reads, no writes."""
    tenants = {r["id"]: r.get("fields") or {} for r in data["tenants"]}
    pay = payments_by_tenancy(data["tx"])
    feed = feed_state(data, pay, now)
    pre_slate, late_before = set(data.get("preSlate") or ()), set(data.get("lateBefore") or ())
    no_chase = set(data.get("noChase") or ())
    no_chase_tenancies = set(data.get("noChaseTenancies") or ())
    rows = []
    for rec in data["tenancies"]:
        f = rec.get("fields") or {}
        start = parse_day(f.get(TY["start"]))
        if not is_live(f, day) or (start and start > day):
            continue
        row = judge(rec, tenants, pay.get(rec["id"], []), day, feed, pre_slate, late_before,
                    nil=(data.get("nilDues") or {}).get(rec["id"], ()),
                    nil_unchecked=rec["id"] in (data.get("nilUnchecked") or ()))
        if rec["id"] in no_chase_tenancies or no_chase & set(f.get(TY["tenants"]) or []):
            row["noChase"] = True
            if not row["paying"]:
                row["note"] += "; not chased: standing instruction"
        rows.append(row)
    surge = [r for r in rows if r.get("fresh")]
    if len(surge) >= max(MASS_LATE_MIN, MASS_LATE_SHARE * len(rows)):
        why = (f"{len(surge)} tenancies turned late at once, which usually means payments are not in "
               "or not matched yet")
        for r in surge:
            r.update(light="grey", lane="unknown", bank=True, note="cannot tell: " + why)
            del r["daysLate"]
    rows.sort(key=lambda r: (("red", "grey", "amber", "green").index(r["light"]), r["unit"]))
    counts = {light: sum(1 for r in rows if r["light"] == light) for light in ("green", "amber", "red", "grey")}
    total, paying = len(rows), sum(1 for r in rows if r["paying"])
    share = 100 * paying / total if total else 0.0
    # Red on Home means someone new has stopped paying, or the check cannot tell. A tenancy Kevin has
    # chosen to leave alone, a new tenant whose first rent is not due yet, and a short payment are amber.
    attention = [r for r in rows if not r["paying"] and r["lane"] in ("late", "unknown")]
    if not total or any(r["light"] == "red" and r["lane"] != "existing" for r in rows) or (share < FLOOR_PCT and attention):
        worst = "fail"
    else:
        worst = "warn" if total - counts["green"] or feed["blocked"] else "ok"
    res = {"asAt": day.isoformat(), "worst": worst, "total": total, "paying": paying, "pct": round(share, 1),
           "belowFloor": share < FLOOR_PCT, "floor": FLOOR_PCT,
           "markedInPayment": sum(1 for r in rows if r["status"] == IN_PAYMENT), "counts": counts,
           "bankBlocked": any(r.get("bank") for r in rows),
           "feed": {"asAt": feed["asAt"], "feeds": feed["feeds"], "waiting": len(feed["waiting"]), "blocked": feed["blocked"]},
           "tenancies": [{k: v for k, v in r.items() if k not in ("fresh", "bank", "listed", "paying", "full")}
                         for r in rows if r["light"] != "green" or r.get("listed")],
           "lights": {r["id"]: r["light"] for r in rows}, "lanes": {r["id"]: r["lane"] for r in rows},
           # Tenancies whose last rent cycle was paid in full on trusted bank data (scripts/rent_cap.py).
           "paidFull": sorted(r["id"] for r in rows if r.get("full"))}
    res["briefLine"] = brief_line(res)
    return res


def brief_line(res):
    """The one line Home prints. Plain words, the figure first."""
    if not res["total"]:
        return "No live tenancy could be judged, so the rent check tells you nothing today."
    parts = [f"{res['paying']} of {res['total']} tenants paying ({res['pct']}%, floor {res['floor']}%)."]
    # A rent text ClickSend may not have sent goes first after the figure: Home prints only 700 characters.
    texts = text_check.brief(res.get("texts") or {})
    if texts:
        parts.append(texts)
    residency = rent_proof_of_residency.brief(res.get("residency") or {})
    if residency:
        parts.append(residency)
    # A signed agreement with no tenancy record (9 Oct 2026): a tenant the figure above does not even count.
    signed = rent_signed_check.brief(res.get("signed") or {})
    if signed:
        parts.append(signed)
    roy = rent_roy_email.brief(res.get("royEmail") or {})
    if roy:
        parts.append(roy)

    def group(lane):
        return [r for r in res["tenancies"] if r["lane"] == lane and r["light"] != "green"]

    def names(rows, text):
        shown = "; ".join(text(r) for r in rows[:BRIEF_NAMES_MAX])
        return shown + (f"; and {len(rows) - BRIEF_NAMES_MAX} more" if len(rows) > BRIEF_NAMES_MAX else "") + "."

    def staged(r):
        # Lane B's few words for the stage. The whole of it is in the row's note, not here: the
        # line is read in short form (Home printed its first 700 characters until 14 Oct 2026).
        return f"{r['unit']} ({r['stage']})" if r.get("stage") else r["unit"]

    if group("late"):
        parts.append("Late: " + names(group("late"), lambda r: (
            f"{r['unit']} ({r['daysLate']} day{'s' if r['daysLate'] != 1 else ''}"
            + (f", {r['stage']}" if r.get("stage") else ", marked actioned so not chased" if r["status"] == CFV_ACTIONED else "")
            + ")" if "daysLate" in r
            else staged(r) if r.get("stage") else f"{r['unit']} ({r['note']})")))
    if group("new"):
        parts.append("New tenants not in payment yet: " + names(group("new"), staged))
    if group("short"):
        parts.append("Paid short: " + names(group("short"), lambda r: f"{r['unit']} ({money(r['got'])} of {money(r['rent'])})"))
    if group("existing"):
        parts.append("Existing cash flow voids, left alone: " + names(group("existing"), staged))
    grey = [r for r in res["tenancies"] if r["light"] == "grey"]
    if grey:
        why = sorted({r["note"].replace("cannot tell: ", "") for r in grey})
        parts.append(f"Cannot tell for {len(grey)}: " + "; ".join(why)[:300] + ".")
    if res["paying"] == res["total"] and not group("short"):
        parts.append("Every tenant in place is paying.")
    if res["feed"]["blocked"] and not res["bankBlocked"]:
        parts.append("Check the bank feed: " + "; ".join(res["feed"]["blocked"])[:300] + ".")
    if res["feed"]["asAt"]:
        parts.append(f"Bank data as at {res['feed']['asAt']}.")
    return " ".join(parts)


def detail(res):
    lines = [res["briefLine"], f"Marked In Payment in Airtable: {res['markedInPayment']} of {res['total']}."]
    lines += [f"{r['light'].upper()} {r['unit']} ({r['type'] or 'type not set'}, {money(r['rent'])}): {r['note']}"
              for r in res["tenancies"]]
    lines.append("Bank feeds: " + ("; ".join(
        f"{x['account']} " + ("never updated" if x["hours"] is None else f"{round(x['hours'])} hours old")
        for x in res["feed"]["feeds"]) or "none found") + ".")
    return "\n".join(lines)


# ─── lane A: one task per late tenancy per stage ─────────────────────
def next_stage(cycle, existing, day):
    """The stage to raise today for one owed payment, or None. `existing` maps a key already raised
    to the day its task was created. First contact is always the reminder, however late it is first
    seen; each later stage waits its gap after the one before."""
    raised = [n for n in STAGES if f"{cycle}:{n}" in existing]
    if not raised:
        return 1
    last = max(raised)
    if last >= max(STAGES) or (day - existing[f"{cycle}:{last}"]).days < STAGE_GAP_DAYS[last]:
        return None
    return last + 1


def task_plan(res, tenancies, existing, day, on_plan=frozenset()):
    """The RENT LATE tasks today's result calls for. Pure: no reads, no writes.

    Only a tenancy the check itself calls late TODAY, on trusted bank data, that we chase ourselves.
    A void already actioned is with the DWP, an existing void is left alone, a short payment is not
    late, and grey means cannot tell. A tenancy with an agreed payment plan on track is not chased:
    the plan is the chase (scripts/rent_plans.py)."""
    by_id = {r["id"]: r.get("fields") or {} for r in tenancies}
    plan = []
    for r in res["tenancies"]:
        if r["lane"] != "late" or r["status"] not in (IN_PAYMENT, CFV) or r["type"] == AGENT_MANAGED:
            continue
        if r.get("noChase") or r["id"] in on_plan:
            continue
        # A void with a part payment sits in the late lane before its next rent is due: not late yet.
        if "daysLate" not in r and not r.get("beyond"):
            continue
        cycle = f"{r['id']}:{r['owed']}"
        number = next_stage(cycle, existing, day)
        if not number:
            continue
        word = STAGES[number]
        owed = parse_day(r["owed"])
        late = (f"{r['daysLate']} days late today" if "daysLate" in r
                else f"no payment matched in the last {TX_LOOKBACK_DAYS} days")
        key = f"{cycle}:{number}"
        f = by_id.get(r["id"]) or {}
        plan.append({
            "key": key, "tenancy": r["id"], "tenants": list(f.get(TY["tenants"]) or []),
            # The tenant's surname stands in for a missing unit: never in a task name (lane B's rule).
            "name": f"{TASK_PREFIX}{lane_b_rules.place_name(r['unit'])}, rent due {owed.strftime('%-d %b')} ({word})",
            "description": "\n".join([
                f"Late rent found by the daily rent check on {day.strftime('%-d %b %Y')}.",
                "TRIAL: you draft, Kevin checks, nothing is sent to the tenant.",
                "",
                f"Tenancy: {r['unit']} (tenancy record {r['id']})",
                f"Tenant type: {r['type'] or 'not set'}",
                f"Rent: {money(r['rent'])} a month",
                f"Rent owed: the payment due {owed.strftime('%-d %b %Y')}, {late}",
                f"What the check saw: {r['note']}",
                f"Payment status in Airtable: {r['status']}",
                f"Stage: {number} of {len(STAGES)}, the {word}",
                f"Bank data as at {res['feed']['asAt'] or 'unknown'}.",
                "",
                "Draft the message for this stage, following your agent file.",
                "",
                # The key is in Notes too. Either copy stops a second task for the same stage.
                KEY_MARK + key,
            ])})
    return plan


def read_task_state():
    """Is the agent switched on (Kevin's pause lever: register Status Built or Live), and which
    cycle-and-stage keys already carry a task, with the day each was raised. Formulas use field
    NAMES: a rename is an error."""
    row = api("GET", T_REGISTER, params={"filterByFormula": f"RECORD_ID()='{REGISTER_ROW}'",
                                         "returnFieldsByFieldId": "true", "pageSize": 1}).get("records") or []
    if len(row) != 1:
        raise RuntimeError("control failed: the Accounts Receivable register row could not be read")
    status = sel((row[0].get("fields") or {}).get(REGISTER_STATUS))
    keys = {}
    for rec in fetch_all(T_TASKS, {"fields[]": [TK["notes"], TK["description"]],
                                   "filterByFormula": f"LEFT({{Task Name}}, {len(TASK_PREFIX)})='{TASK_PREFIX}'"}):
        f = rec.get("fields") or {}
        made = parse_stamp(rec.get("createdTime"))
        made = made.astimezone(LONDON).date() if made else today_london()
        for line in (str(f.get(TK["notes"]) or "") + "\n" + str(f.get(TK["description"]) or "")).splitlines():
            if line.strip().startswith(KEY_MARK):
                key = line.strip()[len(KEY_MARK):].strip()
                keys[key] = min(made, keys.get(key, made))
    return {"on": status in ("Built", "Live"), "status": status, "keys": keys}


def raise_task(item, day):
    """One direct create, like the tenant-finding chain's own tasks: the inbox task gate folds by
    words and cannot tell one rent cycle from the next."""
    fields = {TK["name"]: item["name"], TK["status"]: "Today", TK["due"]: day.isoformat(),
              TK["teamMember"]: [AGENT_TEAM_MEMBER], TK["description"]: item["description"],
              TK["notes"]: "\n".join(KEY_MARK + k for k in [item["key"]] + list(item.get("alsoKeys") or [])),
              TK["tenancies"]: [item["tenancy"]]}
    if item["tenants"]:
        fields[TK["tenants"]] = item["tenants"]
    out = api("POST", T_TASKS, {"records": [{"fields": fields}]})
    return out["records"][0]["id"]


def lane_a(res, tenancies, day, writes, on_plan=frozenset()):
    """Plan and (on a real run) raise today's RENT LATE tasks. Never stops the rent check itself: a
    failure here is reported on the row and in the exit code."""
    out = {"on": False, "status": "", "raised": [], "planned": [], "failed": ""}
    try:
        state = read_task_state()
        out.update(on=state["on"], status=state["status"])
        if not state["on"]:
            return out
        plan = task_plan(res, tenancies, state["keys"], day, on_plan)
        out["planned"] = [p["name"] for p in plan]
        if writes:
            for item in plan:
                raise_task(item, day)
                out["raised"].append(item["name"])
    except Exception as exc:                          # noqa: BLE001 — said on the row, never swallowed
        out["failed"] = str(exc)[:300]
    return out


def letting_agent(f, tenants):
    """(key, name) of the letting agent holding an agent-managed tenancy's rent. On such a tenancy the linked tenant
    record IS the letting agent (Rent Payment Type Agent-Managed; read 16 Nov 2026: one record per agent, linked to
    each of its tenancies). Keyed on the record id, never the name, so two agents are never merged; an agent held under
    two tenant records gets a task per record, the safe direction. With no tenant read, every linked id is the key.
    ("", "") when no tenant is linked."""
    ids = [t for t in (f.get(TY["tenants"]) or []) if isinstance(t, str) and t]
    agents = [t for t in ids if "agent" in sel((tenants.get(t) or {}).get(TN["payType"])).lower()]
    ids = sorted(set(agents or ids))
    names = [str((tenants.get(t) or {}).get(TN["name"]) or "").strip() for t in ids]
    return "+".join(ids), " and ".join(n for n in names if n)


def owed_months(owed, due_day, day, nil=()):
    """How many monthly rents have fallen due from `owed` up to `day`. Every one is unpaid: no payment covers any cycle
    from the owed one on (first_uncovered). A due date the letting agent's statement showed as nil is not counted
    (finding 1354). At least 1."""
    if not 1 <= due_day <= 31:
        return 1
    n, due = 0, owed
    while due <= day:
        n, due = n + (due not in nil), next_due(due, due_day)
    return max(n, 1)


def agent_late_plan(res, tenancies, existing, day, tenants=()):
    """The AGENT RENT LATE steps today's result calls for, from every late agent-managed tenancy per owed payment, on
    trusted bank data, never for a tenant on the do-not-chase list. Pure. Kevin, 5 Oct 2026: "Roy only gets
    escalations for things that we can't physically do. Anything administrative, the AI agent can do." So, per unit:
      1  the Accounts Receivable agent drafts the email to the letting agent (key <tenancy>:<owed>, as before)
      2  AGENT_CHASE_DAYS after it went and the rent still late: a second, firmer email (key ...:2)
      roy AGENT_ROY_DAYS after that and still late: Roy's task to phone them (key ...:roy), emailed to him
    A step waits while the one before is with Kevin; Kevin turning one down ends the chase (his call).

    ONE TASK PER LETTING AGENT PER DUE DATE (Kevin, 13 Nov 2026, on "AGENT RENT LATE: Unit 1 – 22 Newton Street": one
    email covering every unpaid StayCay property, not one per property). Every unit of one letting agent
    (letting_agent) whose oldest unpaid rent fell due the same day, standing at the same step today, goes in ONE task,
    which carries every unit's key line. The step is still worked out per unit from its own key, so:
      * a re-run the same day or the next finds every unit's key and raises nothing again;
      * a per-unit task raised before 16 Nov 2026 holds its unit's key, so that unit never joins a batch for a step it
        already has; its next step joins whichever units of the same agent reach that step the same day;
      * a unit that turns late after its agent's task exists has no key yet: it gets a task of its own for the same
        agent and due date, named "more unit", naming the earlier task. The earlier task is never edited, because it
        may already be drafted, approved or sent.
    Different due dates for one agent are separate tasks: the key is per owed payment."""
    by_id = {r["id"]: r.get("fields") or {} for r in tenancies}
    people = {r["id"]: r.get("fields") or {} for r in tenants or ()}
    groups = {}
    for r in res["tenancies"]:
        # In Payment or a cash flow void: either way the letting agent holds the rent (review, 4 Oct 2026).
        if r["lane"] != "late" or r["status"] not in (IN_PAYMENT, CFV) or r["type"] != AGENT_MANAGED or r.get("noChase"):
            continue
        if "daysLate" not in r and not r.get("beyond"):
            continue
        base = f"{r['id']}:{r['owed']}"
        first_, second = existing.get(base), existing.get(base + ":2")
        if first_ is None:
            step, key = "1", base
        elif first_["status"] != "Completed" or not first_.get("sent"):
            continue                                  # with Kevin, turned down (Cancelled), or closed with nothing sent
        elif second is None:
            if day < first_["sent"] + timedelta(days=AGENT_CHASE_DAYS):
                continue
            step, key = "2", base + ":2"
        elif second["status"] != "Completed" or not second.get("sent") or base + ":roy" in existing:
            continue
        elif day < second["sent"] + timedelta(days=AGENT_ROY_DAYS):
            continue
        else:
            step, key = "roy", base + ":roy"
        f = by_id.get(r["id"]) or {}
        agent, who = letting_agent(f, people)
        # No tenant linked (judge never calls such a tenancy late): the tenancy is its own group, never merged.
        group = groups.setdefault((agent or r["id"], r["owed"], step), {"who": who, "units": []})
        group["units"].append({"row": r, "key": key, "fields": f, "first": first_, "second": second})
    # The first-email tasks already raised per agent and due date: a unit late after them is told apart, never merged in.
    earlier = {}
    for key, t in existing.items():
        tid, _, owed_s = key.partition(":")
        if not owed_s or ":" in owed_s:
            continue
        agent, _ = letting_agent(by_id.get(tid) or {}, people)
        earlier.setdefault((agent or tid, owed_s), set()).add(str(t.get("id") or "?"))
    plan = []
    for (agent, owed_s, step), group in sorted(groups.items()):
        units = sorted(group["units"], key=lambda u: (lane_b_rules.place_name(u["row"]["unit"]), u["row"]["id"]))
        owed = parse_day(owed_s)
        who = group["who"]
        n = len(units)
        before = sorted(earlier.get((agent, owed_s), ())) if step == "1" else []
        count = f"{n}{' more' if before else ''} unit{'s' if n != 1 else ''}"
        lines, total, at_least = [], 0.0, False
        for u in units:
            r = u["row"]
            try:
                due_day = int(sel(u["fields"].get(TY["dueDay"])) or 0)
            except ValueError:
                due_day = 0
            months = owed_months(owed, due_day, day, {parse_day(d) for d in r.get("nilDues") or ()})
            amount = months * r["rent"]
            total += amount
            beyond = "daysLate" not in r
            at_least = at_least or beyond
            late = f"{r['daysLate']} days late today" if not beyond else f"no payment matched in the last {TX_LOOKBACK_DAYS} days"
            lines.append(f"- {lane_b_rules.place_name(r['unit'])}: {'at least ' if beyond else ''}{money(amount)} owed "
                         f"({months} month{'s' if months != 1 else ''} at {money(r['rent'])}, the oldest due "
                         f"{owed.strftime('%-d %b %Y')}), {late}. Tenancy record {r['id']}. What the check saw: {r['note']}")
        holder = f"The letting agent, {who}," if who else "The letting agent"
        head = [f"Raised by the daily rent check on {day.strftime('%-d %b %Y')}.", "",
                f"{holder} collects the rent for {'this unit' if n == 1 else f'these {n} units'} and pays it to us. The "
                f"payment due {owed.strftime('%-d %b %Y')} has not reached us:", *lines,
                f"Total owed: {'at least ' if at_least else ''}{money(total)}.",
                f"Bank data as at {res['feed']['asAt'] or 'unknown'}.", ""]
        if before:
            head += [f"An earlier task for this letting agent and this due date exists ({', '.join(before)}). "
                     f"{'This unit' if n == 1 else 'These units'} turned late after it, so this email covers only "
                     f"{'this unit' if n == 1 else 'these units'}.", ""]
        title = f"{AGENT_LATE_PREFIX}{who or 'an unnamed letting agent'}, rent due {owed.strftime('%-d %b')}"

        def sent(which, units=units):
            """The days the earlier step's emails went for these units (they may differ: per-unit tasks before 16 Nov)."""
            return " and ".join(d.strftime("%-d %b") for d in sorted({u[which]["sent"] for u in units}))
        if step == "1":
            name = f"{title} ({count})"
            # Kevin, 16 Nov 2026 (decision card recinoFWz6fQ6JVVB): letting-agent mail goes from info@ signed Roy.
            # The submit gate refuses any other sender on an AGENT RENT LATE card (agent_email_format.py).
            ask = [f"Draft ONE email to the letting agent covering every unit above, asking what has happened to "
                   f"{'this payment' if n == 1 else 'each payment'} and when it will be paid. It goes from "
                   "info@agilelets.co.uk, signed Roy Lavin, then Agile Lets on the next line (Kevin, 16 Nov 2026), to "
                   "their accounts contact. Read the last emails about this place first (agent-dispatch.py history) "
                   "and quote their subject: it is a new email from info@, because the old threads sit in Kevin's "
                   "Gmail. Nothing goes to the tenant."]
        elif step == "2":
            name = f"{title} ({count}, second email)"
            ask = [f"The email to the letting agent went on {sent('first')} and the rent has still not arrived. One "
                   "email covers every unit above. Draft a second, firmer email, from info@agilelets.co.uk, signed "
                   "Roy Lavin, then Agile Lets on the next line, in the thread of the first email where it went from "
                   "info@, asking for the payment date in writing. Nothing goes to the tenant."]
        else:
            name = f"{title} ({count}): phone the letting agent"
            ask = [f"Two emails to the letting agent ({sent('first')} and {sent('second')}) and the rent for "
                   f"{'this unit' if n == 1 else 'these units'} has still not arrived. Please phone them, ask when it "
                   "will be paid, and reply to this email with what they say. Nothing has been sent to the tenant."]
        keys = [u["key"] for u in units]
        plan.append({
            "keys": keys, "step": step, "agent": agent, "tenancies": [u["row"]["id"] for u in units],
            "tenants": sorted({t for u in units for t in (u["fields"].get(TY["tenants"]) or [])}), "name": name,
            "description": "\n".join(head + ask + ["", "Reference for the rent check, please leave it in:"]
                                     + [AGENT_LATE_MARK + k for k in keys])})
    return plan


SENT_STAMP_RE = re.compile(r"\[(\d{2} \w{3} \d{4}) \d{2}:\d{2} — send-email\] SENT:")


def read_agent_late():
    """{key: {id, status, sent}} for every AGENT RENT LATE task, whatever its status (a closed one still counts:
    one task per step per owed payment). `sent` is the day the send door stamped it SENT, or None. Found by its name
    OR its key line, so a task renamed by hand is still found (review, 4 Oct 2026). The formula uses field NAMES:
    a rename is an error, never an empty read."""
    out = {}
    formula = (f"OR(LEFT({{Task Name}}, {len(AGENT_LATE_PREFIX)})='{AGENT_LATE_PREFIX}', "
               f"FIND('{AGENT_LATE_MARK}', {{Notes}}&''), FIND('{AGENT_LATE_MARK}', {{Description}}&''))")
    for rec in fetch_all(T_TASKS, {"fields[]": [TK["name"], TK["status"], TK["notes"], TK["description"]],
                                   "filterByFormula": formula}):
        f = rec.get("fields") or {}
        notes = str(f.get(TK["notes"]) or "")
        m = SENT_STAMP_RE.search(notes)
        sent = datetime.strptime(m.group(1), "%d %b %Y").date() if m else None
        for line in (notes + "\n" + str(f.get(TK["description"]) or "")).splitlines():
            if line.strip().startswith(AGENT_LATE_MARK):
                out[line.strip()[len(AGENT_LATE_MARK):].strip()] = {"id": rec["id"], "status": sel(f.get(TK["status"])),
                                                                     "sent": sent}
    return out


def agent_late(res, tenancies, day, writes, on, tenants=()):
    """Plan and (on a real run) raise the AGENT RENT LATE steps: the agent's emails to the letting agent, and Roy's
    task at the last step, emailed to him; offer any still-open Roy task to notify again (its ledger never sends a
    second copy). One task per letting agent per due date per step (agent_late_plan): it links every tenancy it covers
    and carries every unit's key line in Notes. Gated on the same agent switch as lanes A and B. Never stops the rent
    check: a failure is said on the row and in the exit code."""
    out = {"on": on, "raised": [], "planned": [], "problems": [], "failed": ""}
    if not on:
        return out
    fails = []
    try:
        existing = read_agent_late()
        plan = agent_late_plan(res, tenancies, existing, day, tenants)
        out["planned"] = [p["name"] for p in plan]
        if not writes:
            return out
        ad = lane_b_rules.module("ad")
        offered = set()
        for key, t in existing.items():
            # A batched Roy task carries a :roy key per unit: offered once, not once per unit.
            if key.endswith(":roy") and t["status"] not in ("Completed", "Cancelled") and t["id"] not in offered:
                offered.add(t["id"])
                try:
                    if lane_b_rules.cut_off(lane_b_rules.notify_roy(t["id"], ad.ROY_EMAIL)):
                        out["problems"].append(f"the email of task {t['id']} to Roy was cut off part way and is not sent twice")
                except Exception as exc:              # noqa: BLE001 — said on the row; a failed email turns the run red
                    if "REFUSED" in str(exc):
                        out["problems"].append(f"task {t['id']} was refused by the email gate: {str(exc)[:120]}")
                    else:
                        fails.append(f"task {t['id']} could not be emailed to Roy: {str(exc)[:120]}")
        for item in plan:
            fields = {TK["name"]: item["name"], TK["status"]: "Today", TK["due"]: day.isoformat(),
                      TK["description"]: item["description"],
                      TK["notes"]: "\n".join(AGENT_LATE_MARK + k for k in item["keys"]),
                      TK["tenancies"]: list(item["tenancies"])}
            if item["step"] == "roy":
                fields[TK["teamMember"]] = [ad.HUMANS[ad.ROY_EMAIL]["rec"]]
                fields[ad.AF["assignee"]] = {"email": ad.ROY_EMAIL}
            else:
                fields[TK["teamMember"]] = [AGENT_TEAM_MEMBER]
            if item["tenants"]:
                fields[TK["tenants"]] = item["tenants"]
            tid = api("POST", T_TASKS, {"records": [{"fields": fields}]})["records"][0]["id"]
            out["raised"].append(item["name"])
            if item["step"] != "roy":
                continue
            try:
                lane_b_rules.notify_roy(tid, ad.ROY_EMAIL)
            except Exception as exc:                  # noqa: BLE001 — the task stands; the next run offers it again
                # A refusal reads the same on the day it is raised as on every run after (review, 4 Oct 2026):
                # a check on the row, since the task already sits on Roy's list. Anything else turns the run red.
                if "REFUSED" in str(exc):
                    out["problems"].append(f"task {tid} was refused by the email gate: {str(exc)[:120]}")
                else:
                    fails.append(f"task {tid} was created but its email to Roy failed (offered again next run): {str(exc)[:120]}")
    except Exception as exc:                          # noqa: BLE001
        fails.append(str(exc)[:300])
    out["failed"] = "; ".join(fails)[:600]
    return out


def agent_late_line(late):
    check = (" Check: " + "; ".join(late["problems"]) + ".") if late.get("problems") else ""
    if late["failed"]:
        return f"Agent-managed late rent FAILED: {late['failed']}{check}"
    if not late["on"]:
        return f"Agent-managed late rent: none raised, the Accounts Receivable agent is switched off or unread.{check}"
    if late["raised"]:
        return "Agent-managed late rent raised: " + "; ".join(late["raised"]) + "." + check
    if late["planned"]:
        return "Agent-managed late rent a real run would raise: " + "; ".join(late["planned"]) + "." + check
    return "Agent-managed late rent: none needed today." + check


def lane_a_line(tasks):
    if tasks["failed"]:
        return f"Late-rent tasks FAILED: {tasks['failed']}"
    if not tasks["on"]:
        return f"Late-rent tasks: none raised, the Accounts Receivable agent is switched off (register status {tasks['status'] or 'unread'})."
    if tasks["raised"]:
        return "Late-rent tasks raised for the agent (trial, nothing is sent): " + "; ".join(tasks["raised"]) + "."
    if tasks["planned"]:
        return "Late-rent tasks a real run would raise: " + "; ".join(tasks["planned"]) + "."
    return "Late-rent tasks: none needed today."


# ─── writing ─────────────────────────────────────────────────────────
def write_row(status, text, payload, now):
    stamp = now.strftime("%Y-%m-%dT%H:%M:%S.000Z")
    fields = {ES["key"]: STATUS_KEY, ES["kind"]: "report", ES["label"]: "Daily rent check",
              ES["schedule"]: "Daily 07:30 and 12:30", ES["status"]: status, ES["lastRun"]: stamp,
              ES["detail"]: text[:9000], ES["payload"]: json.dumps(payload), ES["updated"]: stamp}
    if status != "Failed":
        fields[ES["lastWorked"]] = stamp
    have = api("GET", T_ESTATE, params={"filterByFormula": f"{{Key}}='{STATUS_KEY}'", "pageSize": 1})
    recs = have.get("records") or []
    if recs:
        api("PATCH", T_ESTATE, {"records": [{"id": recs[0]["id"], "fields": fields}], "typecast": True})
    else:
        api("POST", T_ESTATE, {"records": [{"fields": fields}], "typecast": True})


def append_history(res, now):
    os.makedirs(os.path.dirname(HISTORY), exist_ok=True)
    with open(HISTORY, "a") as fh:
        fh.write(json.dumps({"at": now.strftime("%Y-%m-%dT%H:%M:%SZ"), "day": res["asAt"], "total": res["total"],
                             "paying": res["paying"], "pct": res["pct"], "bankBlocked": res["bankBlocked"],
                             "feedAsAt": res["feed"]["asAt"],
                             "lights": res["lights"], "lanes": res["lanes"]}) + "\n")


class _Here:
    """This module, handed to lane B so it reads and writes through the same helpers (and a test's
    stand-ins for them)."""

    def __getattr__(self, name):
        try:
            return globals()[name]
        except KeyError:
            raise AttributeError(name)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("cmd", choices=["run", "status"])
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args(argv)
    day, now = today_london(), datetime.now(timezone.utc)
    writes = a.cmd == "run" and not a.dry_run
    try:
        data = load(day)
        res = assess(data, day, now)
        if res["total"] < LIVE_FLOOR:
            raise RuntimeError(f"control failed: only {res['total']} live tenancies were judged (expected {LIVE_FLOOR}+); "
                               "the read is broken, not the business empty")
    except Exception as exc:                        # noqa: BLE001 — the row is the monitor; say so loudly
        why = f"The rent check could not run: {str(exc)[:300]}"
        if writes:
            write_row("Failed", why, {"asAt": day.isoformat(), "worst": "fail", "briefLine": why}, now)
        print(json.dumps({"failed": why}, indent=2))
        return 1
    # Payment plans first, read only: a tenancy on an agreed plan that is on track is not chased by lane A.
    plans = rent_plans.read(_Here(), data, day, res, now)
    res["tasks"] = lane_a(res, data["tenancies"], day, writes, plans["onTrack"])
    # The agent's switch is lane A's read. With no status read back, lane B is told so, not "off".
    switch = res["tasks"]["on"] if res["tasks"]["status"] else None
    # Roy's emailed answers to a housing costs check go on his task first, so lane B reads them this run.
    res["royEmail"] = rent_roy_email.run(_Here(), data, now, writes, switch)
    res["setup"] = lane_b_rules.lane_b(_Here(), res, data, day, writes, switch, now)
    res["agentLate"] = agent_late(res, data["tenancies"], day, writes, switch, data["tenants"])
    res["plans"] = rent_plans.act(_Here(), plans, data, day, writes, switch, res)
    res["cap"] = rent_cap.run(_Here(), data, day, res, writes, switch, plans["onTrack"])
    res["forms"] = rent_form_chase.run(_Here(), data, day, res, writes, switch)
    res["texts"] = text_check.run(_Here(), now, writes)
    res["residency"] = rent_proof_of_residency.run(_Here(), now, writes, switch, day=day)
    res["signed"] = rent_signed_check.run(_Here(), now, writes, switch, data, day=day)
    res["briefLine"] = brief_line(res)              # lane B has put each new tenant's stage on its row
    failed = (res["tasks"]["failed"] or res["setup"]["failed"] or res["agentLate"]["failed"] or res["plans"]["failed"]
              or res["cap"]["failed"] or res["forms"]["failed"] or res["texts"]["failed"] or res["residency"]["failed"]
              or res["signed"]["failed"] or res["royEmail"]["failed"])
    if writes:
        public = {k: v for k, v in res.items() if k not in ("lights", "lanes", "paidFull")}
        # Blocked only when the bank data hid a verdict: a stale feed with every rent already seen hides nothing.
        status = "Failed" if failed else ("Blocked" if res["bankBlocked"] or res["plans"].get("stuck") else "Worked")
        write_row(status, "\n".join([detail(res), lane_a_line(res["tasks"]), rent_roy_email.line(res["royEmail"]),
                                      lane_b_rules.lane_b_line(res["setup"]),
                                      agent_late_line(res["agentLate"]), rent_plans.line(res["plans"]),
                                      rent_cap.line(res["cap"]), rent_form_chase.line(res["forms"]),
                                      text_check.line(res["texts"]), rent_proof_of_residency.line(res["residency"]),
                                      rent_signed_check.line(res["signed"])]),
                  public, now)
        append_history(res, now)
    print(json.dumps({"written": writes, "briefLine": res["briefLine"], "worst": res["worst"],
                      "counts": res["counts"], "tenancies": res["tenancies"], "feed": res["feed"],
                      "tasks": res["tasks"], "setup": res["setup"], "agentLate": res["agentLate"], "plans": res["plans"],
                      "cap": res["cap"], "forms": res["forms"], "texts": res["texts"], "residency": res["residency"],
                      "signed": res["signed"], "royEmail": res["royEmail"]},
                     indent=2, default=str))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
