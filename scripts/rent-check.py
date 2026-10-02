#!/usr/bin/env python3
"""The daily rent check (Kevin, 2 Oct 2026): phase 1 of the Cash Flow Voids agent.

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
It sends nothing, changes no tenancy, tenant or payment status, and creates no task. The one
write is its own Estate Status row.

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
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

LONDON = ZoneInfo("Europe/London")
BASE = "appnqjDpqDniH3IRl"
PAT_PATH = os.path.expanduser("~/.config/od/airtable_pat")
HISTORY = os.path.expanduser("~/knowledge-os/logs/rent-check/history.jsonl")

# ─── tables and fields (ids, so a rename in Airtable cannot silently blank a read) ───
T_TENANCIES, T_TENANTS = "tblN51a88qTDB6iMH", "tblX4elTuu01gwBYh"
T_TX, T_ACCOUNTS, T_ESTATE = "tbln0gzhCAorFc3zB", "tbl1nr0EcX2T62KME", "tblZVrdzivyBueZVf"
TY = {"rent": "fldDMyfZLFMeONPq8", "dueDay": "fldhy2U0CQmM2oS4P", "payStatus": "fldxU3dPUnbK0SCDq",
      "start": "fld2rPXwwV8dXb1zF", "end": "fldwHhhKAq4f1nY9e", "tenants": "fld1i5bDoHL3B6rUf",
      "tenantStatus": "fldgWAyha1Uij1SZP", "unitRef": "fldql2nyQlPfkPP4p", "hasTx": "fldQpk89SnnMLCpxa",
      "surname": "fldOXazTqBWieEOK2"}
TN = {"payType": "fldZbrk8Xw5Dcwxhi"}
TX = {"date": "fldoyQ6Rr9cHp3bgQ", "tenancy": "fldPmAMmxwqs4SdPa", "amount": "fldot7iisZeL3WrdR",
      "account": "fld9hm24JQUPOCoWj"}
AC = {"alias": "fld21HAxSawQCxICj", "updated": "fld8HOlbBrXbHesoA"}
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
IN_PAYMENT, CFV, CFV_ACTIONED = "In Payment", "CFV", "CFV Actioned"
AGENT_MANAGED = "Agent-Managed"
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


def api(method, path, payload=None, params=None):
    url = f"https://api.airtable.com/v0/{BASE}/{path}"
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
        "lateBefore": read_late_before(day),
    }
    check_controls(data)
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


def judge(rec, tenants, payments, day, feed, pre_slate, late_before):
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

    if status in (CFV, CFV_ACTIONED):
        word = "cash flow void actioned" if status == CFV_ACTIONED else "cash flow void"
        if judged and got is None:
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
        return dict(row, light=light, lane="late", note=f"{word}, {last}{extra}")
    if status != IN_PAYMENT:
        return dict(row, light="grey", lane="unknown", note=f"cannot tell: payment status is '{status or 'blank'}'")
    if late:
        if cannot_tell():
            return dict(row, light="grey", lane="unknown", bank=True, note=cannot_tell())
        if beyond:
            return dict(row, light="red", lane="late", note=last)
        return dict(row, light="red" if days_late >= RED_AFTER_DAYS else "amber", lane="late", daysLate=days_late,
                    fresh=since_owed <= TOLERANCE_DAYS + 1 and rec["id"] not in late_before,
                    note=f"late {days_late} day{'s' if days_late != 1 else ''}, due {owed.strftime('%-d %b')}, {last}")
    # Paid short is only said on a trusted feed.
    if got is not None and trusted:
        return dict(row, light="amber", lane="short", paying=True, got=got, note=f"paid short: {part}, {last}")
    return dict(row, light="green", lane="fine", paying=True,
                note=last if newest else f"first rent due {owed.strftime('%-d %b')}")


def assess(data, day, now):
    """The whole result for one day, from already-read records. No reads, no writes."""
    tenants = {r["id"]: r.get("fields") or {} for r in data["tenants"]}
    pay = payments_by_tenancy(data["tx"])
    feed = feed_state(data, pay, now)
    pre_slate, late_before = set(data.get("preSlate") or ()), set(data.get("lateBefore") or ())
    rows = []
    for rec in data["tenancies"]:
        f = rec.get("fields") or {}
        start = parse_day(f.get(TY["start"]))
        if not is_live(f, day) or (start and start > day):
            continue
        rows.append(judge(rec, tenants, pay.get(rec["id"], []), day, feed, pre_slate, late_before))
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
           "tenancies": [{k: v for k, v in r.items() if k not in ("fresh", "bank", "listed", "paying")}
                         for r in rows if r["light"] != "green" or r.get("listed")],
           "lights": {r["id"]: r["light"] for r in rows}, "lanes": {r["id"]: r["lane"] for r in rows}}
    res["briefLine"] = brief_line(res)
    return res


def brief_line(res):
    """The one line Home prints. Plain words, the figure first."""
    if not res["total"]:
        return "No live tenancy could be judged, so the rent check tells you nothing today."
    parts = [f"{res['paying']} of {res['total']} tenants paying ({res['pct']}%, floor {res['floor']}%)."]

    def group(lane):
        return [r for r in res["tenancies"] if r["lane"] == lane and r["light"] != "green"]

    def names(rows, text):
        shown = "; ".join(text(r) for r in rows[:BRIEF_NAMES_MAX])
        return shown + (f"; and {len(rows) - BRIEF_NAMES_MAX} more" if len(rows) > BRIEF_NAMES_MAX else "") + "."

    if group("late"):
        parts.append("Late: " + names(group("late"), lambda r: (
            f"{r['unit']} ({r['daysLate']} day{'s' if r['daysLate'] != 1 else ''})" if "daysLate" in r
            else f"{r['unit']} ({r['note']})")))
    if group("new"):
        parts.append("New tenants not in payment yet: " + names(group("new"), lambda r: r["unit"]))
    if group("short"):
        parts.append("Paid short: " + names(group("short"), lambda r: f"{r['unit']} ({money(r['got'])} of {money(r['rent'])})"))
    if group("existing"):
        parts.append("Existing cash flow voids, left alone: " + names(group("existing"), lambda r: r["unit"]))
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


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("cmd", choices=["run", "status"])
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args(argv)
    day, now = today_london(), datetime.now(timezone.utc)
    writes = a.cmd == "run" and not a.dry_run
    try:
        res = assess(load(day), day, now)
        if res["total"] < LIVE_FLOOR:
            raise RuntimeError(f"control failed: only {res['total']} live tenancies were judged (expected {LIVE_FLOOR}+); "
                               "the read is broken, not the business empty")
    except Exception as exc:                        # noqa: BLE001 — the row is the monitor; say so loudly
        why = f"The rent check could not run: {str(exc)[:300]}"
        if writes:
            write_row("Failed", why, {"asAt": day.isoformat(), "worst": "fail", "briefLine": why}, now)
        print(json.dumps({"failed": why}, indent=2))
        return 1
    if writes:
        public = {k: v for k, v in res.items() if k not in ("lights", "lanes")}
        # Blocked only when the bank data hid a verdict: a stale feed with every rent already seen hides nothing.
        write_row("Blocked" if res["bankBlocked"] else "Worked", detail(res), public, now)
        append_history(res, now)
    print(json.dumps({"written": writes, "briefLine": res["briefLine"], "worst": res["worst"],
                      "counts": res["counts"], "tenancies": res["tenancies"], "feed": res["feed"]}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
