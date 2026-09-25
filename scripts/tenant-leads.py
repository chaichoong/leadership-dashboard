#!/usr/bin/env python3
"""The tenant-finding chain (Kevin, 25 Sep 2026): a steady flow of single adults aged 35 or over
on Universal Credit who need a room, so voids and spare rooms fill fast.

WHY THIS IS A SCRIPT AND NOT AN AGENT
The agent gate scored the job 12/20, but nine of its ten steps are if/then rules: spot an
opening, pick who to email, screen a form answer, hand a list to Roy, raise a £50 bonus. A rule
is cheaper and steadier than a model, so the rules live here. The judgement stays with the
workers that already exist: the Researcher refreshes the referrer list each quarter, and the
Inbox agents answer replies. Every email still goes through Kevin's one approval queue.

THE CHAIN (one daily run, in this order)
  1. replies     read info@ for replies to the chain's emails: STOP opts the sender out for good
                 (Email Opt-outs table), NO marks a lead Not looking, YES keeps them on the list
  2. screen      a form entry becomes Qualified, Waiting to turn 35 or Not suitable, by rule;
                 a past applicant (2017-2021 sheet) is never screened onto an email list
  3. mail-out    one card per town: the SAME words to every active referrer near it, each sent
                 separately (TO-EACH), every 14 days while rooms are open, 28 with none
  4. adverts     one task for Roy per town with openings: SpareRoom, OpenRent, Gumtree, Find My
                 Move and Facebook copy, each with its own form link so the channel is recorded
  5. referral    one card per town with openings, every 28 days: current UC tenants aged 35+
                 hear about the £50 bonus
  6. viewings    qualified leads for a town with openings go to Roy, plus up to five past
                 applicants a week to PHONE (no consent on file for texts or emails); an open
                 list gets the new names added and Roy is emailed the update
  7. keep warm   once a month, one card asks qualified leads with an email if they still need
                 a room
  8. settle      a card whose send finished stamps Last Emailed / Last Contacted on the people it
                 reached (a PARTIAL send is never settled)
  9. convert     a lead whose phone or email turns up on a new tenant becomes Became tenant
 10. bonus       a converted lead referred by a tenant, whose first rent has landed, puts £50
                 for that tenant on the Friday Payment Run list
 11. archive     a qualified lead we have not heard from for 180 days is archived
 12. monitor     one Estate Status row (key tenant-chain): each step, when it last happened,
                 and what did NOT happen that should have. Kevin's condition for letting Roy
                 take tasks unasked: he can see it working.

WHAT COUNTS AS OURS: a unit whose property is self-managed ('Property Portfolio') and whose
Growth Strategy (on the property, or on the unit) is a UC HMO or UC joint tenancy. The unit
fields are blank across the portfolio (read 25 Sep 2026), so the property decides; a run that
finds none fails loudly rather than reporting "no openings".

Usage:
  tenant-leads.py run [--dry-run] [--only STEP]   the daily pass (--only: one step, no status row)
  tenant-leads.py openings                        what counts as an opening today
  tenant-leads.py status                          the chain monitor, computed, not written
Auth: ~/.config/od/airtable_pat (never printed).
"""

import argparse
import contextlib
import importlib.util
import io
import json
import os
import re
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

HERE = os.path.dirname(os.path.abspath(__file__))
# The sending identity and the TO-EACH cap live in ONE place, shared with the send gate
# (tests/approval-gate-defaults.test.js refuses a script that defines its own sender).
sys.path.insert(0, HERE)
from agent_email_format import PROPERTY_SENDER as SENDER, TO_EACH_MAX  # noqa: E402

LONDON = ZoneInfo("Europe/London")
BASE = "appnqjDpqDniH3IRl"
PAT_PATH = os.path.expanduser("~/.config/od/airtable_pat")

# ─── tables and fields (ids, so a rename in Airtable cannot silently blank a read) ───
T_LEADS, T_REFS, T_OPTOUTS = "tbliYKA44VBFeLduP", "tbl0V6ginecespKny", "tblQwebvwEjTV0Wae"
T_UNITS, T_TENANCIES, T_TENANTS = "tblM3mZCR5kiEdWMj", "tblN51a88qTDB6iMH", "tblX4elTuu01gwBYh"
T_PROPS, T_GROWTH, T_TASKS = "tbl6f0OkAmTC2jbuG", "tblHqr2kyiL15a8LN", "tblqB8b22hKBL4PF1"
T_INVOICES, T_ESTATE = "tblkOTKIG2Tyiy9aM", "tblZVrdzivyBueZVf"

L = {  # Tenant Leads
    "name": "fldraNPm1mfryIiaw", "phone": "fldiyFfkZwg71HAtD", "email": "fldKwSkfjnLNfUppM",
    "dob": "fld9c6k48DBfOx7eC", "turns35": "fldem8X4u7sUEYxHg", "uc": "fldbogVkalbOYL3Bc",
    "single": "fldejyO6AAtUAlyLW", "areas": "fld88dk3qWgFWaSjH", "moveBy": "fldAKZ1IHttv2H013",
    "situation": "fld50cPhlZtFfljCD", "heard": "fldjPyZN3Wq5NaagM", "referredName": "fldXXp9i42Wgzas81",
    "referrer": "fldvPkNHLI9rf2Cu3", "referredTenant": "fld2qz9Oc94BmJoIk", "consent": "fldgPJTwp4f1vc3b3",
    "stage": "fldRpqg93nUnBZLZy", "screening": "fld3djcL3Pf60GWyS", "lastContacted": "fldEma41pcggmWigd",
    "tenant": "fldH5J4SEXEIh0SYm", "royTask": "fldgRbFt08VdrymVH", "bonus": "fldm8vbIfeF8NveIf",
    "legacyRef": "fldKg8Y9IKV7xfuQI", "notes": "fld4jJYvUceieZfi3", "heardFrom": "fldeQgocKOksteeoR",
}
R = {  # Tenant Referrers
    "org": "fldO709oy06qsarDq", "type": "fldJHElViKNWjynR0", "area": "fldBNwAQHaZRwqYhV",
    "email": "fldM552BDanZWxDfe", "confidence": "fldzjVtI5fXBVk2rQ", "status": "fldVxygCrvyySi6yR",
    "lastEmailed": "fld5RQv6Poi8uT1bu",
}
O = {"email": "fld1p2qkcNaoYCYzr", "date": "fldEByD3opXmsAxoh", "who": "fldTy9SBu8wWBTqJN", "how": "fldYB8HxHkXScz12G",
     "decision": "fldLMKDYGD6x9cduQ"}
CHECK_NEEDED, NOT_AN_OPTOUT = "Check needed", "Not an opt-out"
U = {"name": "fldr8sliyu8h2jw9t", "status": "fldBvqysXBm9rIm0E", "letting": "fldcv02tac2Df3JlO",
     "growth": "fldMg7hbVvHXXTQet", "property": "fldUJNRGgzgyAwwjt"}
TY = {"end": "fldwHhhKAq4f1nY9e", "unit": "fld7cjLLEHKAx49OK", "firstPayment": "fldUYUfrOdBLP9nXi"}
TN = {"name": "fldxBKW7QnujSDWqA", "status": "fldAXzP9SGIHiAhrv", "rentType": "fldZbrk8Xw5Dcwxhi",
      "dob": "fldv7FKsqXYswyCFE", "aged35": "flddQ2HnQEf4HBeRn", "email": "fldybEduFY3DWWTfT",
      "phone": "fldraHUkWfqo4olLF", "unit": "fldeLsZYqbKS77S2V", "tenancies": "fldWijr5nOIcKJMP4"}
P = {"name": "fldqMbR329TNY974G", "area": "fldYLRz2GgVojKaq9", "strategy": "fldivZ9UbAACwv7Yh",
     "agent": "fldEUrWVhSp3NY8Hh"}
G = {"title": "fldbjOfQOnUnpFmkZ", "lever": "fldcpnAHgAxQeHAgT", "status": "fldDKDIgcekYZSFp7",
     "property": "fldYjvuoYHNlumtHd"}
TK = {"name": "fldgFjGBw6bTKJFCD", "status": "fldx4qCw17UfrKpaN", "due": "fld7XP8w8kbxfETV4",
      "team": "flduCtmQGpOA4eWaj", "desc": "fldRGhBQViKZKtkQ6", "notes": "fldR7apBzSp3oxFxz",
      "outcome": "fldrHBSr6qoUfaKuZ", "approvedAt": "fldr4Mvf2RzKvhZhi"}
INV = {"payee": "fldBVAMn9vA1by7MN", "description": "fldT0onwVg9JDJ1sv", "amount": "fldauZCUSWeIfGryG",
       "emailDate": "fldEpaivUV4uXW3DP", "due": "fldrZ0BrweP0VCVyR", "status": "fldJ5InUPlY4t7MgP",
       "msgId": "fldnbLSFMemMuLSzP", "runDate": "fldwtlpZOL9oa7OZo", "source": "fldQeBwA2nnepf9wv",
       "notes": "fldV2xsw9en67ts0o"}
ES = {"key": "fldLO6xJqkokvVR4g", "kind": "fldfjQOn76VpgKEfZ", "label": "fldlnvvTh8l5UIih4",
      "schedule": "fldZGa0UD76lVLww7", "status": "fldhOUiva3bqPNk1c", "lastRun": "flduxV3TYwp9wQX9O",
      "lastWorked": "fldMIx3kWMM23vDBN", "detail": "fldLRFP2nJttDVQOa", "payload": "fldiqs9lvyLimoR7i",
      "updated": "fld3q8WN5XqrER92Z"}

# ─── the chain's rules (Kevin, 25 Sep 2026) ──────────────────────────
FORM_URL = "https://airtable.com/appnqjDpqDniH3IRl/shrTuDF8s04Kp5XGT"
STATUS_KEY = "tenant-chain"
SELF_MANAGED = "Property Portfolio"
# Growth Strategy values meaning rooms for our niche. The old names are still read (Growth Plan v3).
UC_STRATEGIES = {"UC HMO", "UC joint tenancy", "HMO", "Joint tenancy", "Add tenants"}
FREE_NOW, BEING_READIED = ("Void", "Rent Ready"), ("Not Ready",)
ROOM_LEVERS = {"Room release", "New room let"}
LIVE_LEVER_STATUSES = {"Adopted", "In progress"}
NOTICE_WINDOW_DAYS = 60
MAILOUT_EVERY_DAYS, MAILOUT_QUIET_EVERY_DAYS = 14, 28
ADVERTS_EVERY_DAYS, REFERRAL_EVERY_DAYS, KEEPWARM_EVERY_DAYS = 14, 28, 28
KEEPWARM_AFTER_DAYS, ARCHIVE_AFTER_DAYS = 30, 180
PAST_APPLICANTS_PER_TASK, PAST_APPLICANT_TASK_EVERY_DAYS = 5, 7
BONUS_AMOUNT = 50
# Towns that always get the quiet "register now" mail-out, openings or not: the home cluster.
HOME_TOWNS = ("Haverhill",)
# Referrers who serve people near a town. A Haverhill room suits someone moving on from Cambridge.
NEAR = {
    "Haverhill": {"Haverhill", "West Suffolk", "Cambridge", "South Cambridgeshire",
                  "East Cambridgeshire", "Braintree", "Uttlesford"},
    "Soham": {"Soham", "East Cambridgeshire", "Cambridge", "West Suffolk"},
}
# Task-name lanes. No hyphens: create-agent-task.py keys a task on its "LANE:" prefix only when
# the prefix is letters and spaces, so each kind of chain task keeps a lane of its own and can
# never fold into another kind (review, 25 Sep 2026).
PREFIXES = {"mailout": "TENANT MAILOUT: ", "adverts": "TENANT ADVERTS: ", "referral": "TENANT REFERRAL: ",
            "viewings": "TENANT VIEWINGS: ", "keepwarm": "TENANT KEEPWARM: "}
EMAIL_KINDS = ("mailout", "referral", "keepwarm")
OPEN_TASK_STATES = ("Completed", "Cancelled")
QUALIFIED_STAGES = ("Qualified", "With Roy")
APPROVED = ("Approved as-is", "Approved with minor edits")
SENT_RE = re.compile(r"^\[(\d{1,2} \w{3} \d{4})[^\]]*— send-email\] SENT: mail-out", re.M)
PARTIAL_RE = re.compile(r"— send-email\] PARTIAL: mail-out")
IDS_RE = re.compile(r"^TENANT CHAIN IDS: (.*)$", re.M)
SETTLED_MARK = "TENANT CHAIN SETTLED"
# Replies to the chain's emails, read from info@ (step 1). The window is 30 days and each message is
# acted on ONCE (a seen-ids file), so a run gap cannot lose a STOP and a daily re-read cannot undo a
# correction someone made by hand. STOP words in the query catch a fresh email as well as a reply.
REPLY_WINDOW_DAYS = 30
REPLY_QUERY = ('newer_than:%dd -from:%s (subject:"Rooms in" OR subject:"still looking for a room" '
               'OR subject:"when a friend moves in" OR stop OR unsubscribe OR "remove me" OR "opt out")'
               % (REPLY_WINDOW_DAYS, SENDER))
REPLIES_SEEN = os.path.expanduser("~/knowledge-os/logs/tenant-leads/replies-seen.json")
# An opt-out is permanent and no person sees it, so only an unmistakable one counts: the FIRST line
# of what they wrote is essentially the word. "Haverhill One Stop Shop" in a signature, "is there a
# bus stop" or "please don't stop" are left for a person (review, 25 Sep 2026).
STOP_LINE_RE = re.compile(
    r"^\W*(please\s+(can\s+you\s+)?)?"
    r"(stop|unsubscribe(\s+(me|us))?|remove\s+(me|us)"
    r"|take\s+(me|us)\s+off(\s+(your|the|this)\s+(mailing\s+|email\s+|e-mail\s+)?list)?|opt[\s-]?(me\s+)?out)"
    r"(\s+(emailing|sending|contacting|mailing|messaging)(\s+(me|us))?(\s+(these|this|any\s+more|again))?(\s+e-?mails?)?)?"
    r"(\s+(from|off)\s+(your|the|this)\s+(mailing\s+|email\s+|e-mail\s+)?list)?"
    r"(\s+please)?(\W+(thanks?|thank\s+you|cheers)(\s+you)?)?\W*$", re.I)
# Looser: a STOP word somewhere in what they wrote. Never acted on automatically (a signature reading
# "One Stop Shop" matches); it is shown on the monitor for a person to decide.
STOP_LOOSE_RE = re.compile(r"\b(stop|unsubscribe|remove\s+(me|us)|take\s+(me|us)\s+off|opt[\s-]?out)\b", re.I)
GREETING_RE = re.compile(r"^\W*(hi|hello|hey|dear|good\s+(morning|afternoon|evening))\b[^.!?]{0,40}\W*$", re.I)
YES_LINE_RE = re.compile(r"^\W*(yes|yeah|yep)\b(?!.*\b(not|no\s+longer|found|moved)\b).{0,40}$", re.I)
NO_LINE_RE = re.compile(r"^\W*no(\s+(thanks|thank\s+you))?\W*$", re.I)
AUTO_SUBJECT_RE = re.compile(r"^\s*(automatic reply|auto(matic)?[- ]?reply|out of (the )?office)", re.I)
QUOTE_RE = re.compile(r"^(On .+wrote:|-{2,}\s*Original Message|From: .+|>|_{5,})", re.M)
ADDR_RE = re.compile(r"[^<>\s@,;]+@[^<>\s@,;]+\.[^<>\s@,;]+")


# ─── small helpers ───────────────────────────────────────────────────
def today_london():
    return datetime.now(LONDON).date()


def parse_day(v):
    if isinstance(v, list):
        v = v[0] if v else None
    if not v:
        return None
    try:
        return date.fromisoformat(str(v)[:10])
    except ValueError:
        return None


def age_on(dob, day):
    return day.year - dob.year - ((day.month, day.day) < (dob.month, dob.day))


def add_years(d, n):
    try:
        return d.replace(year=d.year + n)
    except ValueError:                     # 29 Feb
        return d.replace(year=d.year + n, day=28)


def sel(v):
    return v.get("name", "") if isinstance(v, dict) else (v or "")


def links(v):
    return [x for x in (v or []) if isinstance(x, str)]


def digits(s):
    d = re.sub(r"\D", "", str(s or ""))
    if d.startswith("44") and len(d) == 12:
        d = "0" + d[2:]
    return d if len(d) >= 10 else ""


def email_of(v):
    return str(v or "").strip().lower()


def norm_name(s):
    return " ".join(re.sub(r"[^a-z ]", " ", str(s or "").lower()).split())


def street(name):
    """'5 Dalham Place' -> 'Dalham Place': emails name the street, never the door."""
    return re.sub(r"^\s*(flat|unit|apt)?\s*\w*\d+\w*\s*[,-]?\s*", "", str(name or ""), flags=re.I).strip() or str(name or "")


def form_link(channel):
    q = urllib.parse.urlencode({"prefill_How They Heard": channel, "hide_How They Heard": "true"})
    return f"{FORM_URL}?{q}"


def fmt_day(d):
    return d.strftime("%-d %b %Y") if d else ""


def is_legacy(lead):
    """A past applicant (2017-2021 sheet): phoned only, never emailed or texted."""
    return bool(lead["fields"].get(L["legacyRef"]))


def lead_areas(lead):
    return [sel(a) for a in lead["fields"].get(L["areas"]) or []]


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


def load(day):
    """Everything the chain reads, once. Controls: tables that always hold rows fail loudly on zero."""
    data = {
        "leads": fetch_all(T_LEADS),
        "refs": fetch_all(T_REFS),
        "optouts": fetch_all(T_OPTOUTS),
        "units": fetch_all(T_UNITS, {"fields[]": list(U.values())}),
        "tenancies": fetch_all(T_TENANCIES, {"fields[]": list(TY.values())}),
        "tenants": fetch_all(T_TENANTS, {"fields[]": list(TN.values())}),
        "props": fetch_all(T_PROPS, {"fields[]": list(P.values())}),
        "levers": fetch_all(T_GROWTH, {"fields[]": list(G.values())}),
        "tasks": fetch_all(T_TASKS, {"filterByFormula": "LEFT({Task Name}, 7)='TENANT '",
                                     "fields[]": list(TK.values())}),
    }
    # The silent-zero trap: 64 units, 60 tenants and 248 imported leads exist, so zero is a broken read.
    for k, floor in (("units", 20), ("tenants", 20), ("props", 10), ("leads", 100), ("tenancies", 20)):
        if len(data[k]) < floor:
            raise RuntimeError(f"control failed: {k} read returned {len(data[k])} rows (expected {floor}+); "
                               "the read is broken, not the business empty")
    return data


def suppressed(data):
    """Every address on the Email Opt-outs table unless a person marked it Not an opt-out. That
    includes 'Check needed' rows (a reply that MAY ask us to stop): held off every list until a
    person decides, the safe direction (review, 25 Sep 2026)."""
    return {email_of(o["fields"].get(O["email"])) for o in data.get("optouts", [])
            if sel(o["fields"].get(O["decision"])) != NOT_AN_OPTOUT} - {""}


def checks_waiting(data):
    return [o["fields"] for o in data.get("optouts", []) if sel(o["fields"].get(O["decision"])) == CHECK_NEEDED]


# ─── 1. what is ours, and the openings ───────────────────────────────
def scope(data):
    """{unit id: (town, property name)} for self-managed units let as UC rooms or joint tenancies."""
    props = {p["id"]: p["fields"] for p in data["props"]}
    out = {}
    for u in data["units"]:
        f = u["fields"]
        unit_strategy = sel(f.get(U["growth"])) or sel(f.get(U["letting"]))
        for pid in links(f.get(U["property"])):
            pf = props.get(pid) or {}
            if str(pf.get(P["agent"]) or "").strip() != SELF_MANAGED:
                continue
            strategy = unit_strategy if unit_strategy and unit_strategy != "Leave as is" else sel(pf.get(P["strategy"]))
            if strategy in UC_STRATEGIES:
                out[u["id"]] = (str(pf.get(P["area"]) or "").strip(), str(pf.get(P["name"]) or ""))
    if not out:
        raise RuntimeError("control failed: no self-managed unit is let as a UC HMO or UC joint tenancy; "
                           "the property strategies or the agent field have changed, so no void could be seen")
    return out


def openings(data, day):
    ours = scope(data)
    units = {u["id"]: u["fields"] for u in data["units"]}
    props = {p["id"]: p["fields"] for p in data["props"]}
    out = []
    for uid, (town, prop) in ours.items():
        status = sel(units[uid].get(U["status"]))
        if status in FREE_NOW:
            out.append({"key": f"unit:{uid}", "kind": "void", "town": town, "property": prop, "rooms": 1,
                        "from": day.isoformat(), "label": f"{prop}: a room free now"})
        elif status in BEING_READIED:
            out.append({"key": f"unit:{uid}", "kind": "prep", "town": town, "property": prop, "rooms": 1,
                        "from": None, "label": f"{prop}: a room being made ready"})
    for t in data["tenancies"]:
        f = t["fields"]
        end = parse_day(f.get(TY["end"]))
        if not end or not (day <= end <= day + timedelta(days=NOTICE_WINDOW_DAYS)):
            continue
        for uid in links(f.get(TY["unit"])):
            if uid in ours and sel(units[uid].get(U["status"])) not in FREE_NOW + BEING_READIED:
                town, prop = ours[uid]
                out.append({"key": f"tenancy:{t['id']}", "kind": "notice", "town": town, "property": prop,
                            "rooms": 1, "from": end.isoformat(), "label": f"{prop}: a room free from {fmt_day(end)}"})
    for lv in data["levers"]:
        f = lv["fields"]
        lever, status = sel(f.get(G["lever"])), sel(f.get(G["status"]))
        if not ((lever in ROOM_LEVERS and status in LIVE_LEVER_STATUSES)
                or (lever == "Take-back" and status == "In progress")):
            continue
        pids = links(f.get(G["property"]))
        town = next((str((props.get(p) or {}).get(P["area"]) or "").strip() for p in pids), "")
        prop = next((str((props.get(p) or {}).get(P["name"]) or "") for p in pids), "")
        m = re.search(r"(\d+)\s+more\s+rooms?", str(f.get(G["title"]) or ""), re.I)
        rooms = int(m.group(1)) if m else (2 if lever == "Take-back" else 1)
        out.append({"key": f"lever:{lv['id']}", "kind": "room", "town": town, "property": prop, "rooms": rooms,
                    "from": None, "label": f"{prop}: {rooms} room{'s' if rooms != 1 else ''} coming up"})
    return sorted(out, key=lambda o: (o["town"], o["property"], o["key"]))


def by_town(opens):
    towns = {}
    for o in opens:
        towns.setdefault(o["town"] or "Unknown", []).append(o)
    return towns


def let_towns(data):
    """Every town where we let UC rooms, openings or not (a Soham lead is not unsuitable on a quiet day)."""
    return {town for town, _ in scope(data).values() if town} | set(HOME_TOWNS)


# ─── the chain's own tasks ───────────────────────────────────────────
REFUSED_MARK = "TENANT CHAIN REFUSED"


def chain_tasks(data, kind, town=None):
    """The chain's own tasks of one kind (optionally for a town). A card the submit gate refused is
    left out, so the chain tries again the next day and the monitor stays red until one lands."""
    pre = PREFIXES[kind] + (town or "")
    return [t for t in data["tasks"] if str(t["fields"].get(TK["name"]) or "").startswith(pre)
            and REFUSED_MARK not in str(t["fields"].get(TK["notes"]) or "")]


def created_day(rec):
    return parse_day(rec.get("createdTime"))


def is_open(task):
    return sel(task["fields"].get(TK["status"])) not in OPEN_TASK_STATES


def due_again(tasks, every_days, day):
    """(due, why): nothing open, and the newest is older than the interval."""
    live = [t for t in tasks if is_open(t)]
    if live:
        oldest = min(created_day(t) for t in live)
        return False, f"waiting since {fmt_day(oldest)}"
    last = max((created_day(t) for t in tasks), default=None)
    if last and (day - last).days < every_days:
        return False, f"last one {fmt_day(last)}"
    return True, ""


def sent_days(tasks):
    return [datetime.strptime(m, "%d %b %Y").date()
            for t in tasks for m in SENT_RE.findall(str(t["fields"].get(TK["notes"]) or ""))]


# ─── emails (cards) ──────────────────────────────────────────────────
def rooms_line(opens):
    n = sum(o["rooms"] for o in opens)
    streets = sorted({street(o["property"]) for o in opens if o["property"]})
    dated = sorted(o["from"] for o in opens if o["from"])
    when = ("free now" if any(o["kind"] == "void" for o in opens)
            else f"free from {fmt_day(parse_day(dated[0]))}" if dated else "coming up soon")
    return n, streets, when


def email_block(to_each, subject, body, record, carry):
    return (f"{record}\nTO-EACH: {', '.join(to_each)}\nFROM: {SENDER}\nSUBJECT: {subject}\n---\n"
            f"{body.strip()}\n\nKind regards\nRoy Lavin\nAgile Lets\n\n"
            f"**Carrying this out will involve:** {carry}")


def track_record(dates, what):
    """The dated TRACK RECORD block submit requires on Correspondence (Kevin, 8 Sep 2026)."""
    dated = sorted({d for d in dates if d})
    if not dated:
        return f"TRACK RECORD: none found (searched {what})"
    return "TRACK RECORD:\n" + "\n".join(f"- {fmt_day(d)}: the last {what} went out" for d in dated[-3:])


def mailout_body(towns, day):
    """The same words for every referrer in one group: every open town near them, or 'register now'."""
    link = form_link("Referrer")
    open_towns = [t for t, os_ in towns if os_]
    if open_towns:
        parts = []
        for town, os_ in towns:
            n, streets, when = rooms_line(os_)
            parts.append(f"- {town}: {n} room{'s' if n != 1 else ''} {when}, in shared houses on "
                         f"{', '.join(streets) or 'streets in ' + town}.")
        where = " and ".join(open_towns)
        return (f"Rooms in {where} for single adults aged 35+ on Universal Credit",
                f"Hello,\n\nAgile Lets has rooms for single adults aged 35 or over who claim Universal Credit:\n\n"
                + "\n".join(parts) + "\n\n"
                "The rent matches the one-bedroom Local Housing Allowance rate, so the housing element covers it. "
                "We welcome people moving on from hostels, supported housing or sofa surfing.\n\n"
                "If you work with someone who needs a room, please ask them to fill in our two-minute form, "
                f"or fill it in with them:\n{link}\n\nWe reply to everyone who fits.\n\n"
                "If you would rather not hear from us, reply STOP and we will take you off our list.")
    where = " and ".join(t for t, _ in towns)
    return (f"Rooms in {where} for single adults aged 35+ on Universal Credit",
            f"Hello,\n\nAgile Lets lets rooms in {where} to single adults aged 35 or over who claim Universal "
            "Credit. Rooms come up through the year, and the rent matches the one-bedroom Local Housing "
            "Allowance rate.\n\nIf you work with someone who needs one, please ask them to register now "
            f"with our two-minute form, so we can call them as soon as a room is free:\n{link}\n\n"
            "If you would rather not hear from us, reply STOP and we will take you off our list.")


def referrers_busy(data, day, pending_only=False, for_rooms=True):
    """Referrer ids a mail-out card holds: while it waits, while it is sent but not yet settled, and
    for its own interval from the day it was raised whatever became of it. A card Kevin rejects
    therefore holds its referrers for 14 days (28 for "register now") instead of coming back the
    next morning (review, 25 Sep 2026). A card the submit gate refused holds nobody (chain_tasks)."""
    busy = set()
    for t in chain_tasks(data, "mailout"):
        name = str(t["fields"].get(TK["name"]) or "")
        notes_text = str(t["fields"].get(TK["notes"]) or "")
        # A "register now" card holds its referrers 28 days against another register-now card, but
        # only 14 against news of real rooms: a room that opens is told within a fortnight.
        every = MAILOUT_QUIET_EVERY_DAYS if ("register now" in name and not for_rooms) else MAILOUT_EVERY_DAYS
        recent = (not pending_only) and created_day(t) and (day - created_day(t)).days < every
        sent_unsettled = bool(SENT_RE.search(notes_text)) and SETTLED_MARK not in notes_text
        ids = IDS_RE.search(notes_text)
        if ids and (is_open(t) or sent_unsettled or recent):
            busy |= {x.strip() for x in ids.group(1).split(",") if x.strip()}
    return busy


def mailout_cards(data, towns, day):
    """One card per group of referrers who share the same open towns near them.

    Due per REFERRER, not per town (review, 25 Sep 2026): every Soham referrer also serves Haverhill,
    so a card per town left Soham's always empty. Each referrer hears at most every 14 days while a
    town near them has rooms, every 28 days with none, and is never on two waiting cards."""
    stop = suppressed(data)
    busy_rooms, busy_quiet = referrers_busy(data, day, for_rooms=True), referrers_busy(data, day, for_rooms=False)
    rank = {"High": 0, "Medium": 1, "Low": 2}
    groups = {}
    for r in data["refs"]:
        f = r["fields"]
        email = email_of(f.get(R["email"]))
        if not email or email in stop or sel(f.get(R["status"])) != "Active":
            continue
        area = sel(f.get(R["area"]))
        near_open = tuple(sorted(t for t in towns if area in NEAR.get(t, {t})))
        near_home = tuple(sorted(t for t in HOME_TOWNS if area in NEAR.get(t, {t})))
        key, every = (near_open, MAILOUT_EVERY_DAYS) if near_open else (near_home, MAILOUT_QUIET_EVERY_DAYS)
        if not key or r["id"] in (busy_rooms if near_open else busy_quiet):
            continue
        last = parse_day(f.get(R["lastEmailed"]))
        if last and (day - last).days < every:
            continue
        groups.setdefault(key, []).append((rank.get(sel(f.get(R["confidence"])), 3), email, r["id"]))
    cards = []
    for key, rows in sorted(groups.items()):
        seen, refs = set(), []
        for _, email, rid in sorted(rows):
            if email not in seen:
                seen.add(email)
                refs.append((email, rid))
        open_towns = [t for t in key if t in towns]
        subject, body = mailout_body([(t, towns.get(t, [])) for t in key], day)
        label = " and ".join(key) + (" rooms" if open_towns else " register now")
        for i in range(0, len(refs), TO_EACH_MAX):
            chunk = refs[i:i + TO_EACH_MAX]
            ids = {rid for _, rid in chunk}
            last = [parse_day(r["fields"].get(R["lastEmailed"])) for r in data["refs"] if r["id"] in ids]
            what = ("; ".join(o["label"] for t in open_towns for o in towns[t]) if open_towns
                    else "rooms coming up, so they register people now")
            cards.append({
                "kind": "mailout", "town": key[0], "towns": list(key),
                "name": f"{PREFIXES['mailout']}{label} {fmt_day(day)}" + (f" ({i // TO_EACH_MAX + 1})" if len(refs) > TO_EACH_MAX else ""),
                "description": f"Tenant-finding chain: tell {len(chunk)} council, charity and support contacts near {' and '.join(key)} about {what}.",
                "output": email_block([e for e, _ in chunk], subject, body,
                                      track_record(last, "mail-out to these contacts (Tenant Referrers, Last Emailed)"),
                                      f"sending this email separately to each of the {len(chunk)} contacts above from {SENDER}."),
                "ids": [rid for _, rid in chunk], "emails": [e for e, _ in chunk],
                "plainTask": f"Tell {len(chunk)} housing and support contacts near {' and '.join(key)} we have rooms for people aged 35+ on Universal Credit.",
                "plainApprove": f"The same short email goes to each of the {len(chunk)} contacts separately, from info@agilelets.co.uk, signed Roy Lavin."})
    return cards


def referrers_near(data, town):
    return [r for r in data["refs"] if sel(r["fields"].get(R["status"])) == "Active" and r["fields"].get(R["email"])
            and sel(r["fields"].get(R["area"])) in NEAR.get(town, {town})]


def tenant_town(data, tenant_fields):
    units = {u["id"]: u["fields"] for u in data["units"]}
    props = {p["id"]: p["fields"] for p in data["props"]}
    for uid in links(tenant_fields.get(TN["unit"])):
        for pid in links((units.get(uid) or {}).get(U["property"])):
            area = (props.get(pid) or {}).get(P["area"])
            if area:
                return str(area).strip()
    return ""


def referral_recipients(data, town, day):
    stop, out = suppressed(data), []
    for t in data["tenants"]:
        f = t["fields"]
        if sel(f.get(TN["status"])) != "Active" or sel(f.get(TN["rentType"])) != "Universal Credit":
            continue
        dob = parse_day(f.get(TN["dob"]))
        if not (f.get(TN["aged35"]) or (dob and age_on(dob, day) >= 35)):
            continue
        email = email_of(f.get(TN["email"]))
        if email and email not in stop and tenant_town(data, f) == town and email not in out:
            out.append(email)
    return out[:TO_EACH_MAX]


def referral_card(data, town, opens, day):
    to = referral_recipients(data, town, day)
    if not to:
        return None
    n, _, _ = rooms_line(opens)
    body = (f"Hello,\n\nWe have {n} room{'s' if n != 1 else ''} coming free in {town}. Do you know someone aged "
            "35 or over, living on their own and claiming Universal Credit, who needs somewhere to live?\n\n"
            "Ask them to fill in this two-minute form and put your name where it asks who told them about us:\n"
            f"{form_link('Tenant referral')}\n\nIf they move in, we pay you £{BONUS_AMOUNT} once their first "
            "month's rent has been paid.\n\nIf you would rather not get these emails, reply STOP.")
    return {"kind": "referral", "town": town, "name": f"{PREFIXES['referral']}{town} friends {fmt_day(day)}",
            "description": f"Tenant-finding chain: ask {len(to)} current tenants in {town} on Universal Credit, aged 35+, to refer a friend for £{BONUS_AMOUNT}.",
            "output": email_block(to, f"£{BONUS_AMOUNT} for you when a friend moves in", body,
                                  track_record(sent_days(chain_tasks(data, "referral", town)),
                                               "tenant referral email (TENANT REFERRAL cards)"),
                                  f"sending this email separately to each of the {len(to)} tenants above from {SENDER}."),
            "ids": [], "emails": to,
            "plainTask": f"Ask {len(to)} of our tenants in {town} to refer a friend who needs a room.",
            "plainApprove": f"Each tenant gets the same short email separately, offering £{BONUS_AMOUNT} when their friend moves in and pays the first rent."}


def heard_day(lead):
    return parse_day(lead["fields"].get(L["heardFrom"])) or created_day(lead)


def keepwarm_leads(data, day):
    stop, out = suppressed(data), []
    for l in data["leads"]:
        f = l["fields"]
        if (is_legacy(l) or sel(f.get(L["stage"])) not in QUALIFIED_STAGES or not f.get(L["consent"])
                or not f.get(L["email"]) or email_of(f.get(L["email"])) in stop):
            continue
        last = parse_day(f.get(L["lastContacted"])) or created_day(l)
        heard = heard_day(l)
        if last and (day - last).days >= KEEPWARM_AFTER_DAYS and heard and (day - heard).days < ARCHIVE_AFTER_DAYS:
            out.append(l)
    return out[:TO_EACH_MAX]


def keepwarm_card(data, day):
    leads = keepwarm_leads(data, day)
    if not leads:
        return None
    to, seen = [], set()
    for l in leads:
        e = email_of(l["fields"].get(L["email"]))
        if e not in seen:
            seen.add(e)
            to.append(e)
    body = ("Hello,\n\nYou registered with Agile Lets for a room. Are you still looking?\n\n"
            f"- If yes, reply YES. If anything has changed, fill in the form again: {form_link('Other')}\n"
            "- If you have found somewhere, reply NO and we will stop contacting you.")
    last = [parse_day(l["fields"].get(L["lastContacted"])) for l in leads]
    return {"kind": "keepwarm", "town": "", "name": f"{PREFIXES['keepwarm']}room list check {fmt_day(day)}",
            "description": f"Tenant-finding chain: ask {len(to)} people who registered for a room whether they still need one.",
            "output": email_block(to, "Are you still looking for a room?", body,
                                  track_record(last, "check-in to these people (Tenant Leads, Last Contacted)"),
                                  f"sending this email separately to each of the {len(to)} people above from {SENDER}."),
            "ids": [l["id"] for l in leads], "emails": to,
            "plainTask": f"Check in with {len(to)} people on our room list to see if they still need a room.",
            "plainApprove": "Each person gets the same short email separately asking them to reply YES or NO."}


# ─── adverts (Roy) ───────────────────────────────────────────────────
# Wording rules (researched 25 Sep 2026, brain Knowledge/tenant-finding-channels.md):
#   * age is outside the Equality Act's letting rules (s.32(1)), so "aged 35 or over" is lawful,
#     but Facebook's Commerce Policy bans any age preference, so the Facebook copy carries none;
#   * "Universal Credit welcome" is lawful (Renters' Rights Act 2025 s.34 bans "No DSS");
#   * never "no children" (s.33): a room "suits one adult".
ADVERT_CHANNELS = (
    ("SpareRoom", "SpareRoom (free ad; renew it every 7 days)", True),
    ("OpenRent", "OpenRent (free listing; tick 'DSS/LHA Covers Rent')", True),
    ("Gumtree", "Gumtree (Flats and Houses, rooms to rent; free)", True),
    ("Other", "Find My Move (free; tick 'Suitable for DSS')", True),
    ("Facebook", "Facebook: Marketplace and the {town} community groups, from the Agile Lets page or your own. "
                 "Facebook bans age preferences, so this version does not mention age", False),
)


def adverts_task(town, opens, day):
    n, streets, when = rooms_line(opens)
    where = ", ".join(streets) or town
    blocks = []
    for channel, label, says_age in ADVERT_CHANNELS:
        who = "Suits one adult aged 35 or over" if says_age else "Suits one adult"
        title = (f"Room to rent in {town}, suits one adult aged 35+, Universal Credit welcome" if says_age
                 else f"Room to rent in {town}, suits one adult, Universal Credit welcome")
        blocks.append(
            f"{label.format(town=town)}\nTitle: {title}\n"
            f"Text: Room in a shared house on {where}, {town}, {when}. {who}. Universal Credit welcome: the rent "
            f"matches the one-bedroom housing rate. To apply, fill in our two-minute form: {form_link(channel)}")
    desc = (f"Rooms to fill: {'; '.join(o['label'] for o in opens)}.\n\nPlease post these adverts. Each has its "
            "own form link, so we can see which site brings people in. Photos: two of the room and one of the "
            "kitchen. Reply to this email with DONE and where you posted them.\n\n" + "\n\n".join(blocks))
    return {"kind": "adverts", "town": town, "name": f"{PREFIXES['adverts']}{town} advert copy {fmt_day(day)}",
            "description": desc}


# ─── screening ───────────────────────────────────────────────────────
def lead_towns(areas):
    """Which of our let towns a lead's chosen areas can be served from."""
    towns = set()
    known = {x for n in NEAR.values() for x in n}
    for a in areas or []:
        for town, near in NEAR.items():
            if a in near:
                towns.add(town)
        if a not in known and a != "Other":
            towns.add(a)
    return towns


def screen(f, day, towns):
    """(stage, reason, extra fields) for a New sign-up. Pure: the rules Kevin set, nothing else."""
    extra = {}
    if not f.get(L["consent"]):
        return "Not suitable", "no consent to contact on the form", extra
    dob = parse_day(f.get(L["dob"]))
    if not dob:
        return "New", "no date of birth: ask at the first call", extra
    extra[L["turns35"]] = add_years(dob, 35).isoformat()
    if age_on(dob, day) < 35:
        return ("Waiting to turn 35", f"aged {age_on(dob, day)}; comes back on {fmt_day(add_years(dob, 35))}", extra)
    if sel(f.get(L["uc"])) == "No":
        return "Not suitable", "not on Universal Credit", extra
    if sel(f.get(L["single"])) == "No":
        return "Not suitable", "not moving in on their own", extra
    areas = [sel(a) for a in (f.get(L["areas"]) or [])]
    if not lead_towns(areas) & towns:
        return "Not suitable", f"wants {', '.join(areas) or 'no town'}; we have no rooms there", extra
    note = "fits: 35+, on Universal Credit, living alone"
    if sel(f.get(L["uc"])) in ("Applying", "Unknown"):
        note += f" (Universal Credit: {sel(f.get(L['uc'])).lower()}, check at the viewing)"
    return "Qualified", note, extra


def match_tenant_by_name(data, text):
    """The one ACTIVE tenant whose full name is in the 'who told you' answer; None when zero or several."""
    want = f" {norm_name(text)} "
    hits = [t["id"] for t in data["tenants"] if sel(t["fields"].get(TN["status"])) == "Active"
            and norm_name(t["fields"].get(TN["name"])) and f" {norm_name(t['fields'].get(TN['name']))} " in want]
    return hits[0] if len(hits) == 1 else None


# ─── viewings (Roy) ──────────────────────────────────────────────────
def lead_line(lead, day):
    f = lead["fields"]
    dob = parse_day(f.get(L["dob"]))
    bits = [str(f.get(L["name"]) or "?"), f"aged {age_on(dob, day)}" if dob else "age not given: ask",
            str(f.get(L["phone"]) or ""), str(f.get(L["email"]) or ""),
            f"move by {fmt_day(parse_day(f.get(L['moveBy'])))}" if f.get(L["moveBy"]) else "",
            sel(f.get(L["situation"])), f"heard via {sel(f.get(L['heard']))}" if f.get(L["heard"]) else "",
            f"registered {fmt_day(created_day(lead))}"]
    return ", ".join(b for b in bits if b)


def past_line(lead, day):
    f = lead["fields"]
    dob = parse_day(f.get(L["dob"]))
    return (f"{f.get(L['name']) or '?'}, aged {age_on(dob, day) if dob else '?'}, "
            f"{f.get(L['phone']) or 'no phone'}, applied {(f.get(L['legacyRef']) or '')[11:15]}")


def viewings_text(town, opens, leads, past, day):
    desc = f"Rooms open in {town}: {'; '.join(o['label'] for o in opens)}.\n\n"
    if leads:
        desc += ("These people registered and fit (aged 35+, on Universal Credit, living alone). Please call or "
                 "text each one this week to book a viewing:\n"
                 + "\n".join(f"{i}. {lead_line(l, day)}" for i, l in enumerate(leads, 1)) + "\n\n")
    if past:
        desc += ("PAST APPLICANTS (2017 to 2021). PHONE ONLY: they have not agreed to texts or emails. Ask if they "
                 f"still need a room. If yes, ask them to fill in the form: {form_link('Past applicant')}\n"
                 + "\n".join(f"{i}. {past_line(l, day)}" for i, l in enumerate(past, 1)) + "\n\n")
    return desc + "Reply to this email with what happened to each person: booked, not interested, or no answer."


def viewings_task(data, town, opens, leads, past, day):
    n = len(leads) + len(past)
    return {"kind": "viewings", "town": town, "name": f"{PREFIXES['viewings']}{town} people to call {fmt_day(day)}",
            "description": viewings_text(town, opens, leads, past, day), "leadIds": [l["id"] for l in leads + past],
            "count": n}


def pick_past_applicants(data, town, exclude=frozenset()):
    """Up to five past applicants for Roy to PHONE: never listed before, a phone number on file,
    the town they asked for, those who were on Universal Credit first, then the most recent."""
    held = suppressed(data)
    pool = [l for l in data["leads"] if sel(l["fields"].get(L["stage"])) == "Past applicant"
            and l["id"] not in exclude and not links(l["fields"].get(L["royTask"])) and l["fields"].get(L["phone"])
            and email_of(l["fields"].get(L["email"])) not in held
            and town in lead_towns(lead_areas(l))]
    pool.sort(key=lambda l: str(l["fields"].get(L["legacyRef"]) or ""), reverse=True)
    pool.sort(key=lambda l: sel(l["fields"].get(L["uc"])) != "Yes")
    return pool[:PAST_APPLICANTS_PER_TASK]


# ─── bonus ───────────────────────────────────────────────────────────
def bonus_due(data, lead):
    """The day the referred tenant's first rent landed, or None."""
    f = lead["fields"]
    if sel(f.get(L["stage"])) != "Became tenant" or not links(f.get(L["referredTenant"])):
        return None
    if sel(f.get(L["bonus"])) in ("On payment run", "Paid"):
        return None
    tenants = {t["id"]: t["fields"] for t in data["tenants"]}
    tenancies = {t["id"]: t["fields"] for t in data["tenancies"]}
    for tid in links(f.get(L["tenant"])):
        for ty in links((tenants.get(tid) or {}).get(TN["tenancies"])):
            d = parse_day((tenancies.get(ty) or {}).get(TY["firstPayment"]))
            if d:
                return d
    return None


# ─── replies ─────────────────────────────────────────────────────────
def new_text(body):
    """The words the person wrote, above the quoted email."""
    m = QUOTE_RE.search(body or "")
    return (body[:m.start()] if m else (body or "")).strip()[:600]


def is_auto_reply(headers, subject):
    h = {k.lower(): str(v or "").lower() for k, v in (headers or {}).items()}
    return (h.get("auto-submitted", "no") not in ("", "no") or "x-autoreply" in h or "x-autorespond" in h
            or ("list-unsubscribe" in h and "in-reply-to" not in h)
            or h.get("precedence") in ("auto_reply", "bulk", "junk") or bool(AUTO_SUBJECT_RE.search(subject or "")))


def classify_reply(subject, body, headers=None):
    """'stop' | 'check' | 'yes' | 'no' | None. 'check' = maybe an opt-out: shown for a person to decide."""
    if is_auto_reply(headers, subject):
        return None
    text = new_text(body)
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    while lines and GREETING_RE.match(lines[0]) and not STOP_LOOSE_RE.search(lines[0]):
        lines = lines[1:]                     # "Hi Roy," on its own line
    first = lines[0] if lines else ""
    # "Hi, please stop" / "Hello - STOP" / "Hi Roy stop emailing me": peel a greeting and up to two
    # words (a name) off the front, and test what is left.
    words = first.split()
    tries = [first]
    if words and re.match(r"^\W*(hi|hello|hey|dear|good\s+(morning|afternoon|evening))\b", first, re.I):
        tries += [" ".join(words[k:]) for k in (1, 2, 3) if len(words) > k]
    if any(STOP_LINE_RE.match(t) for t in tries):
        return "stop"
    if STOP_LOOSE_RE.search(text[:400]):
        return "check"
    if "still looking" in str(subject or "").lower():
        if YES_LINE_RE.match(first):
            return "yes"
        if NO_LINE_RE.match(first):
            return "no"
    return None


def replies_seen():
    """Message ids already acted on or read. A bad file is a failure of the replies step only."""
    try:
        with open(REPLIES_SEEN) as fh:
            d = json.load(fh)
    except FileNotFoundError:
        return set()
    except ValueError as exc:
        raise RuntimeError(f"the replies seen-file is unreadable ({exc}); fix or remove {REPLIES_SEEN}")
    return set(d.get("seen", []) if isinstance(d, dict) else d)


def save_replies_seen(ids):
    """Atomic: a half-written seen file would make every reply act again (python-scripts rule)."""
    os.makedirs(os.path.dirname(REPLIES_SEEN), exist_ok=True)
    tmp = REPLIES_SEEN + ".tmp"
    with open(tmp, "w") as fh:
        json.dump({"seen": sorted(ids)[-5000:]}, fh)
    os.replace(tmp, REPLIES_SEEN)


def list_replies():
    """Replies to the chain's emails (and any STOP) in info@ over the last 30 days, via the Gmail worker."""
    spec = importlib.util.spec_from_file_location("tl_tri", os.path.join(HERE, "inbound-triage.py"))
    tri = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(tri)
    try:
        msgs, truncated = tri.worker_list(q=REPLY_QUERY, account=SENDER, max_pages=12)
    except SystemExit as exc:          # the triage transport exits on any worker problem
        raise RuntimeError(f"could not read info@ replies: {getattr(tri, '_last_fail', {}) or exc}")
    # Gmail lists newest first, so a cut drops the oldest, which a daily run has already read. What
    # was read is still processed (the seen file makes that safe); the cut is reported, not fatal.
    return msgs, truncated


# ─── the monitor ─────────────────────────────────────────────────────
def monitor(data, day, opens, run_notes):
    """Each step, the last time it happened, and what did NOT happen that should have.

    A trust surface that lists only successes cannot show a missing step, so every line
    carries its own absence rule (feedback: trust surfaces report absence).
    """
    towns = by_town(opens)
    steps = []

    def step(key, label, last, state, note):
        steps.append({"key": key, "label": label, "last": last.isoformat() if last else None,
                      "state": state, "note": note})

    step("openings", "Openings found", day if opens else None, "ok" if opens else "idle",
         f"{sum(o['rooms'] for o in opens)} room(s): " + "; ".join(o["label"] for o in opens) if opens
         else "No void, notice or adopted room move right now.")

    for kind, label, every in (("mailout", "Referrer mail-out", MAILOUT_EVERY_DAYS),
                               ("adverts", "Adverts to Roy", ADVERTS_EVERY_DAYS),
                               ("referral", "Tenant referral email", REFERRAL_EVERY_DAYS)):
        tasks = chain_tasks(data, kind)
        last = max((created_day(t) for t in tasks), default=None)
        bad, warn = [], []
        for town in towns:
            if kind == "mailout":
                # The chain's own clock: is some referrer near this town on a card, or emailed lately?
                # Told = an email actually went (Last Emailed) or a card is waiting / being sent. A card
                # closed without sending (rejected, or tidied away) is NOT telling anyone.
                near = referrers_near(data, town)
                pending = referrers_busy(data, day, pending_only=True)
                told = [r for r in near if r["id"] in pending or ((lambda d: d and (day - d).days <= every + 2)
                                                                  (parse_day(r["fields"].get(R["lastEmailed"]))))]
                if near and not told:
                    bad.append(f"{town}: no referrer near it emailed in {every + 2} days")
                continue
            newest = max((created_day(t) for t in chain_tasks(data, kind, town)), default=None)
            if not newest or (day - newest).days > every + 2:
                (warn if kind == "referral" else bad).append(f"{town}: none in {every + 2} days")
        waiting = [t for t in tasks if is_open(t) and (day - created_day(t)).days > 3]
        if waiting:
            warn.append(f"{len(waiting)} open more than 3 days")
        if kind == "mailout":
            closed = [t for t in tasks if not is_open(t) and (day - created_day(t)).days <= every
                      and not SENT_RE.search(str(t["fields"].get(TK["notes"]) or ""))]
            if closed:
                warn.append(f"{len(closed)} closed without sending in the last {every} days")
        state = "fail" if bad else "warn" if warn else ("ok" if last else "idle")
        step(kind, label, last, state, "; ".join(bad + warn) or (f"last {fmt_day(last)}" if last else "none yet"))

    unsent, partial = [], []
    for kind in EMAIL_KINDS:
        for t in chain_tasks(data, kind):
            f = t["fields"]
            notes = str(f.get(TK["notes"]) or "")
            approved_at = parse_day(f.get(TK["approvedAt"]))
            if sel(f.get(TK["outcome"])) in APPROVED and approved_at and (day - approved_at).days >= 1 \
                    and not SENT_RE.search(notes):
                (partial if PARTIAL_RE.search(notes) else unsent).append(str(f.get(TK["name"]) or t["id"]))
    sends = sent_days(data["tasks"])
    unsure = [str(t["fields"].get(TK["name"]) or t["id"]) for kind in EMAIL_KINDS for t in chain_tasks(data, kind)
              if "UNCERTAIN" in str(t["fields"].get(TK["notes"]) or "") and (day - created_day(t)).days <= 14]
    step("sent", "Approved emails actually sent", max(sends, default=None),
         "fail" if unsent or partial else "warn" if unsure else ("ok" if sends else "idle"),
         "; ".join((["Approved but not sent after a day: " + ", ".join(unsent)] if unsent else [])
                   + (["Stopped part way: " + ", ".join(partial)] if partial else [])
                   + (["Some addresses may not have received it: " + ", ".join(unsure)] if unsure else []))
         or "Every approved card has a SENT stamp.")

    real = [l for l in data["leads"] if not is_legacy(l)]
    newest = max((created_day(l) for l in real), default=None)
    recent = [l for l in real if (day - created_day(l)).days <= 14]
    first_mail = min(sent_days(chain_tasks(data, "mailout")), default=None)
    asking = (day - first_mail).days if first_mail else None
    if recent:
        state, note = "ok", f"{len(recent)} in the last 14 days"
    elif opens and asking is not None and asking > 30 and not (newest and (day - newest).days <= 30):
        state, note = "fail", f"rooms open and no sign-up in 30 days, {asking} days after the first mail-out"
    elif opens and asking is not None and asking > 14:
        state, note = "warn", "rooms open and no sign-up in 14 days"
    else:
        state, note = "idle", "No sign-ups yet" + (f"; the first mail-out went {fmt_day(first_mail)}" if first_mail else "")
    step("leads", "New sign-ups", newest, state, note)

    blank = [l for l in real if not sel(l["fields"].get(L["stage"])) and (day - created_day(l)).days >= 2]
    no_dob = [l for l in real if sel(l["fields"].get(L["stage"])) == "New"]
    step("screening", "Sign-ups screened", day, "fail" if blank else "warn" if no_dob else "ok",
         (f"{len(blank)} sign-up(s) with no stage after 2 days: the screen step is not running" if blank else
          f"{len(no_dob)} sign-up(s) gave no date of birth: ask at the first call" if no_dob else
          "Every sign-up has a stage."))

    roy = chain_tasks(data, "viewings")
    unhanded = [l for l in real if sel(l["fields"].get(L["stage"])) == "Qualified"
                and lead_towns(lead_areas(l)) & set(towns)]
    with_roy = [l for l in real if sel(l["fields"].get(L["stage"])) == "With Roy"]
    open_roy = {t["id"] for t in roy if is_open(t)}
    past_with_roy = [l for l in data["leads"] if is_legacy(l) and sel(l["fields"].get(L["stage"])) == "Past applicant"
                     and set(links(l["fields"].get(L["royTask"]))) & open_roy]
    step("viewings", "Viewings list to Roy", max((created_day(t) for t in roy), default=None),
         "fail" if unhanded else "ok" if roy else "idle",
         (f"{len(unhanded)} qualified people for an open town not yet with Roy" if unhanded else
          f"Roy has {len(with_roy)} sign-up(s) and {len(past_with_roy)} past applicant(s) to call"))

    kw = chain_tasks(data, "keepwarm")
    due = keepwarm_leads(data, day)
    last_kw = max((created_day(t) for t in kw), default=None)
    step("keepwarm", "Keep-warm check-in", last_kw,
         "warn" if due and (not last_kw or (day - last_kw).days > KEEPWARM_EVERY_DAYS + 3) else "ok" if last_kw else "idle",
         f"{len(due)} people due a check-in" if due else "Nobody due a check-in.")

    flagged = checks_waiting(data)
    step("optouts", "Possible opt-outs to check", None, "warn" if flagged else "ok",
         ("Replies that may ask us to stop, held off every email list until someone decides: "
          + "; ".join(f'{email_of(f.get(O["email"]))} said "{str(f.get(O["how"]) or "")[:80]}"' for f in flagged)
          + ". In the Email Opt-outs table, set Decision to Opted out or Not an opt-out.") if flagged else "None waiting.")

    owed = [l for l in data["leads"] if bonus_due(data, l)]
    step("bonus", "£50 referral bonuses", None, "warn" if owed else "ok",
         f"{len(owed)} bonus(es) earned but not on the Payment Run" if owed else "None earned and unlisted.")

    stages, sources = {}, {}
    for l in data["leads"]:
        f = l["fields"]
        s = sel(f.get(L["stage"])) or "(blank)"
        stages[s] = stages.get(s, 0) + 1
        if not is_legacy(l):
            h = sel(f.get(L["heard"])) or "Not given"
            sources[h] = sources.get(h, 0) + 1
    worst = "fail" if any(s["state"] == "fail" for s in steps) else "warn" if any(s["state"] == "warn" for s in steps) else "ok"
    return {"asAt": day.isoformat(), "worst": worst, "steps": steps, "openings": opens,
            "stages": stages, "sources": sources,
            "referrers": sum(1 for r in data["refs"]
                             if sel(r["fields"].get(R["status"])) == "Active" and r["fields"].get(R["email"])),
            "optOuts": len(suppressed(data)), "run": run_notes}


def payload_json(mon, limit=95000):
    """The monitor as JSON that always parses: shed the long parts rather than cut mid-string."""
    text = json.dumps(mon)
    for drop in ("run", "openings"):
        if len(text) <= limit:
            break
        mon = dict(mon, **{drop: [f"{len(mon.get(drop) or [])} entries dropped to fit"]})
        text = json.dumps(mon)
    return text if len(text) <= limit else json.dumps({"asAt": mon["asAt"], "worst": mon["worst"], "steps": mon["steps"][:12]})


# ─── writing ─────────────────────────────────────────────────────────
_MODS = {}


def module(key):
    """agent-dispatch.py (submit, handover, Roy's address, the Property Administration id), loaded
    once and called IN PROCESS, so there is no command line to get wrong."""
    files = {"ad": "agent-dispatch.py"}
    if key not in _MODS:
        spec = importlib.util.spec_from_file_location("tl_" + key, os.path.join(HERE, files[key]))
        m = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(m)
        _MODS[key] = m
    return _MODS[key]


def call_in_process(fn, *a, **k):
    """Run another script's command in this process. Returns its last JSON line; raises on refusal."""
    buf = io.StringIO()
    try:
        with contextlib.redirect_stdout(buf):
            rc = fn(*a, **k)
    except SystemExit as exc:
        if exc.code not in (0, None):
            raise RuntimeError(f"{exc.code if not isinstance(exc.code, int) else 'exit ' + str(exc.code)} "
                               f"{buf.getvalue()[-300:]}".strip())
        rc = 0
    out = buf.getvalue()
    if isinstance(rc, int) and rc != 0:
        raise RuntimeError(f"exit {rc}: {out[-300:]}")
    lines = [ln for ln in out.splitlines() if ln.strip().startswith("{")]
    return json.loads(lines[-1]) if lines else {}


class Writer:
    """Every write the chain makes, in one place, so --dry-run is honest."""

    def __init__(self, dry_run):
        self.dry = dry_run
        self.plan = []

    def note(self, what):
        self.plan.append(what)

    def patch(self, table, rows, what):
        merged = {}
        for r in rows:            # one row per record: a lead reached twice in a run is written once
            merged.setdefault(r["id"], {}).update(r["fields"])
        rows = [{"id": i, "fields": f} for i, f in merged.items()]
        if not rows:
            return
        self.note(f"update {len(rows)} {what}")
        if self.dry:
            return
        for i in range(0, len(rows), 10):
            api("PATCH", table, {"records": rows[i:i + 10], "typecast": True})
            time.sleep(0.25)

    def patch_leads(self, rows):
        self.patch(T_LEADS, rows, "lead(s)")

    def opt_out(self, email, who, how, day, decision="Opted out"):
        self.note(f"{decision.lower()}: {who.lower()} {email.split('@')[-1]}")
        if self.dry:
            return None
        out = api("POST", T_OPTOUTS, {"records": [{"fields": {O["email"]: email, O["date"]: day.isoformat(),
                                                                   O["who"]: who, O["how"]: how, O["decision"]: decision}}],
                                          "typecast": True})
        return ((out.get("records") or [{}])[0]).get("id")

    def set_decision(self, email, decision, data):
        rows = [o for o in data.get("optouts", []) if email_of(o["fields"].get(O["email"])) == email and o.get("id")]
        self.note(f"{decision.lower()}: {email.split('@')[-1]} (was Check needed)")
        if self.dry:
            return
        if rows:
            api("PATCH", T_OPTOUTS, {"records": [{"id": o["id"], "fields": {O["decision"]: decision}} for o in rows]})
        else:     # the Check needed row has no id we know: record the decision as a row of its own
            api("POST", T_OPTOUTS, {"records": [{"fields": {O["email"]: email, O["date"]: today_london().isoformat(),
                                                             O["who"]: "Other", O["decision"]: decision,
                                                             O["how"]: "A clear STOP after an unclear reply"}}],
                                    "typecast": True})

    def create_task(self, name, description, notes=""):
        ad = None if self.dry else module("ad")
        fields = {TK["name"]: name, TK["status"]: "Today", TK["due"]: today_london().isoformat(),
                  TK["team"]: [ad.PROPERTY_REC_ID if ad else "recPROPERTYADMIN"], TK["desc"]: description}
        if notes:
            fields[TK["notes"]] = notes
        self.note(f"create task: {name}")
        if self.dry:
            return "recDRYRUN"
        # A DIRECT create, not create-agent-task.py. That gate is built for inbox tasks and did two
        # wrong things to the chain's own: its word pass folded a mail-out into the inbox task a
        # referrer's reply raised, and its track-record step (first live run, 25 Sep 2026) read the
        # Airtable base id inside the form link as a reference, pulling 72,000 characters of
        # unrelated history, a private legal email among them, into the Notes of two tasks bound
        # for Roy. The handover's tier-1 gate refused them, which is the only reason nothing
        # reached him. The chain dedupes its own tasks by lane and interval (due_again), and each
        # email card carries its own TRACK RECORD, so neither step is needed here.
        out = api("POST", T_TASKS, {"records": [{"fields": fields}]})
        tid = ((out.get("records") or [{}])[0]).get("id")
        if not tid:
            raise RuntimeError(f"the task '{name}' was not created: {str(out)[:200]}")
        return tid

    def raise_card(self, card):
        tid = self.create_task(card["name"], card["description"],
                               f"TENANT CHAIN IDS: {','.join(card.get('ids') or [])}")
        self.note(f"submit card {card['kind']} {card['town']} as Correspondence")
        if self.dry:
            return tid
        ad = module("ad")
        with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as fh:
            fh.write(card["output"])
            path = fh.name
        try:
            call_in_process(ad.cmd_submit, argparse.Namespace(
                task=tid, agent=ad.PROPERTY_REC_ID, type="Correspondence", output_file=path,
                plain_task=card["plainTask"], plain_approve=card["plainApprove"], tier1=False,
                siblings=None, coverage=None, receipt=None, attach=None))
        except RuntimeError as exc:
            # A refused card must not sit at Today under an agent: it would block the next
            # mail-out (due_again) and be handed to Property Administration as work.
            api("PATCH", T_TASKS, {"records": [{"id": tid, "fields": {TK["status"]: "Cancelled", TK["notes"]:
                f"TENANT CHAIN IDS: \n\n{REFUSED_MARK}: the submit gate refused this card: {str(exc)[:500]}"}}]})
            raise
        finally:
            os.unlink(path)
        return tid

    def to_roy(self, task):
        tid = self.create_task(task["name"], task["description"])
        self.note(f"hand {task['kind']} {task['town']} to Roy")
        if not self.dry:
            ad = module("ad")
            out = call_in_process(ad.cmd_handover, argparse.Namespace(
                task=tid, to=ad.ROY_EMAIL,
                reason="standing handover: tenant-finding adverts and viewings (Kevin, 25 Sep 2026)"))
            if out.get("NOT EMAILED"):
                raise RuntimeError(f"{task['name']} is Roy's but was NOT emailed to him: {out}")
        return tid

    def seen_replies(self):
        return replies_seen()

    def mark_replies_seen(self, ids):
        if not self.dry:
            save_replies_seen(ids)

    def bonus_row(self, lead, referrer_name, new_tenant, first_rent, day):
        self.note(f"£{BONUS_AMOUNT} bonus on the Payment Run")
        if self.dry:
            return
        key = f"referral-bonus:{lead['id']}"
        have = api("GET", T_INVOICES, params={"filterByFormula": f"{{Gmail Message ID}}='{key}'", "pageSize": 1})
        if have.get("records"):
            return
        api("POST", T_INVOICES, {"records": [{"fields": {
            INV["payee"]: referrer_name, INV["amount"]: float(BONUS_AMOUNT), INV["status"]: "Unpaid",
            INV["description"]: f"Tenant referral bonus: {new_tenant} moved in, first rent {fmt_day(first_rent)}",
            INV["msgId"]: key, INV["emailDate"]: day.isoformat(), INV["runDate"]: day.isoformat(),
            INV["due"]: day.isoformat(), INV["source"]: "Tenant referral",
            INV["notes"]: "Raised by the tenant-finding chain (scripts/tenant-leads.py). Kevin pays; nothing is automated."}}],
            "typecast": True})

    def status_row(self, mon, detail, failed):
        self.note("write the tenant-chain status row")
        now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
        fields = {ES["key"]: STATUS_KEY, ES["kind"]: "report", ES["label"]: "Tenant-finding chain",
                  ES["schedule"]: "Daily 08:10", ES["status"]: "Failed" if failed else "Worked",
                  ES["lastRun"]: now, ES["detail"]: detail[:9000], ES["payload"]: payload_json(mon),
                  ES["updated"]: now}
        if not failed:
            fields[ES["lastWorked"]] = now
        if self.dry:
            return
        have = api("GET", T_ESTATE, params={"filterByFormula": f"{{Key}}='{STATUS_KEY}'", "pageSize": 1})
        recs = have.get("records") or []
        if recs:
            api("PATCH", T_ESTATE, {"records": [{"id": recs[0]["id"], "fields": fields}], "typecast": True})
        else:
            api("POST", T_ESTATE, {"records": [{"fields": fields}], "typecast": True})


# ─── the daily run ───────────────────────────────────────────────────
STEPS = ("replies", "screen", "mail-out", "adverts", "referral", "viewings", "keep-warm", "settle",
         "convert", "bonus", "archive")


def run(data, day, w, only=None, replies=None):
    """Run every step (or only one). One failing step is recorded and the rest still run.

    `replies` is a callable returning Gmail messages (list_replies on a real run)."""
    notes, failures = [], []

    def guard(label, fn):
        try:
            r = fn()
            if r:
                notes.append(f"{label}: {r}")
        except Exception as exc:                       # noqa: BLE001 — recorded, reported, exit non-zero
            failures.append(f"{label}: {str(exc)[:300]}")

    scope_ok = True
    try:
        opens = openings(data, day)
        ours = let_towns(data)
    except Exception as exc:                           # noqa: BLE001 — recorded; the rest still runs
        # The scope control failed: record it so the status row carries the reason today,
        # and still run the steps that do not depend on openings (replies, screening, bonus).
        failures.append(f"openings: {str(exc)[:300]}")
        opens, ours, scope_ok = [], set(HOME_TOWNS), False
    towns = by_town(opens)
    ours |= set(towns)       # a town with an opening is one we let in, even through a take-back

    def do_replies():
        got = (replies or list_replies)()
        msgs, truncated = got if isinstance(got, tuple) else (got, False)
        seen = w.seen_replies()
        # One decision per address, the strictest row winning: Opted out, then Check needed, then cleared.
        rank = {"Opted out": 0, CHECK_NEEDED: 1, NOT_AN_OPTOUT: 2}
        on_table = {}
        for o in data.get("optouts", []):
            e, d = email_of(o["fields"].get(O["email"])), sel(o["fields"].get(O["decision"])) or "Opted out"
            if e and (e not in on_table or rank.get(d, 0) < rank.get(on_table[e], 0)):
                on_table[e] = d
        stop = {e for e, d in on_table.items() if d == "Opted out"}
        refs = {email_of(r["fields"].get(R["email"])): r for r in data["refs"] if r["fields"].get(R["email"])}
        leads = {}
        for l in data["leads"]:
            leads.setdefault(email_of(l["fields"].get(L["email"])), []).append(l)
        tenants = {email_of(t["fields"].get(TN["email"])) for t in data["tenants"]}
        lead_rows, ref_rows, acted, new_seen = [], [], 0, set()
        # Oldest first, so a later clear STOP always has the last word over an earlier unclear reply.
        for m in sorted(msgs, key=lambda x: x.get("internalDate") or 0):
            mid = m.get("id") or ""
            if mid and mid in seen:
                continue
            h = m.get("headers") or {}
            subject = h.get("subject") or m.get("subject") or ""
            sender = next(iter(ADDR_RE.findall(str(h.get("from") or m.get("from") or ""))), "").lower()
            verdict = classify_reply(subject, m.get("body") or m.get("snippet") or "", h)
            if mid:
                new_seen.add(mid)
            if not sender or sender == SENDER or not verdict:
                continue
            if verdict == "check":
                if on_table.get(sender) in (None, NOT_AN_OPTOUT):     # a new doubt after a clearance is asked again
                    who = "Referrer" if sender in refs else "Lead" if sender in leads else \
                          "Tenant" if sender in tenants else "Other"
                    said = new_text(m.get("body") or m.get("snippet") or "")[:300]
                    rid = w.opt_out(sender, who, f"MAY be asking us to stop, in reply to \"{subject}\": \"{said}\"", day,
                                    decision=CHECK_NEEDED)
                    on_table[sender] = CHECK_NEEDED
                    data.setdefault("optouts", []).append({"id": rid, "fields": {O["email"]: sender,
                                                                                 O["decision"]: CHECK_NEEDED, O["how"]: said}})
                continue
            acted += 1
            mine = [l for l in leads.get(sender, []) if sel(l["fields"].get(L["stage"])) != "Became tenant"]
            if verdict == "stop":
                if sender not in stop and on_table.get(sender) == CHECK_NEEDED:
                    w.set_decision(sender, "Opted out", data)
                    stop.add(sender)
                    on_table[sender] = "Opted out"
                elif sender not in stop:
                    who = "Referrer" if sender in refs else "Lead" if sender in leads else \
                          "Tenant" if sender in tenants else "Other"
                    w.opt_out(sender, who, f"Replied STOP to \"{subject}\" ({h.get('date') or m.get('date', '')})", day)
                    stop.add(sender)
                    on_table[sender] = "Opted out"
                    data.setdefault("optouts", []).append({"fields": {O["email"]: sender, O["decision"]: "Opted out"}})
                if sender in refs:
                    ref_rows.append({"id": refs[sender]["id"], "fields": {R["status"]: "Opted out"}})
                # A tenant who opts out keeps Became tenant: the bonus owed to whoever referred them stands.
                lead_rows += [{"id": l["id"], "fields": {L["stage"]: "Opted out", L["screening"]:
                               f"{fmt_day(day)}: replied STOP; never contacted again"}} for l in mine]
            elif verdict == "no":
                lead_rows += [{"id": l["id"], "fields": {L["stage"]: "Not looking", L["heardFrom"]: day.isoformat(),
                               L["screening"]: f"{fmt_day(day)}: replied NO to the check-in"}}
                              for l in mine if not is_legacy(l)]
            elif verdict == "yes":
                lead_rows += [{"id": l["id"], "fields": {L["heardFrom"]: day.isoformat()}}
                              for l in mine if not is_legacy(l)]
        for r in lead_rows:
            next((l for l in data["leads"] if l["id"] == r["id"]), {"fields": {}})["fields"].update(r["fields"])
        w.patch(T_REFS, ref_rows, "referrer(s)")
        w.patch_leads(lead_rows)
        w.mark_replies_seen(seen | new_seen)
        if truncated:
            notes.append("replies: the read was cut at 300 messages; the oldest were left for tomorrow")
        return f"{acted} repl(ies) acted on" if acted else ""

    def do_screen():
        if not scope_ok:
            # Without the list of towns we let in, "we have no rooms there" would be a guess, and it
            # is never revisited. Leave sign-ups blank today; the monitor flags them after 2 days.
            return "skipped: the towns we let in could not be read"
        rows = []
        for l in data["leads"]:
            f = l["fields"]
            stage = sel(f.get(L["stage"]))
            if stage == "Waiting to turn 35":
                turns = parse_day(f.get(L["turns35"]))
                if turns and turns <= day:
                    # A past applicant never becomes a consented lead by a birthday: phone only.
                    nxt = "Past applicant" if is_legacy(l) or not f.get(L["consent"]) else "New"
                    rows.append({"id": l["id"], "fields": {L["stage"]: nxt, L["screening"]:
                                 f"{fmt_day(day)}: turned 35 on {fmt_day(turns)}"}})
                    f[L["stage"]] = nxt
                    stage = nxt
            if is_legacy(l) or stage not in ("", "New"):
                continue
            new, why, extra = screen(f, day, ours)
            fields = {L["stage"]: new, L["screening"]: f"{fmt_day(day)}: {why}", **extra}
            if not f.get(L["heardFrom"]):
                fields[L["heardFrom"]] = (created_day(l) or day).isoformat()
            if new == "Qualified" and f.get(L["referredName"]) and not f.get(L["referredTenant"]):
                tid = match_tenant_by_name(data, f.get(L["referredName"]))
                if tid:
                    fields[L["referredTenant"]] = [tid]
            if new != stage or any(f.get(k) != v for k, v in fields.items() if k != L["screening"]):
                rows.append({"id": l["id"], "fields": fields})
                f.update(fields)
        w.patch_leads(rows)
        return f"{len(rows)} lead(s) moved" if rows else ""

    def do_mailouts():
        for town in towns:
            if not referrers_near(data, town):
                failures.append(f"mail-out {town}: no active referrer with an email near {town}")
        cards = mailout_cards(data, towns, day)
        for card in cards:
            w.raise_card(card)
        return ", ".join(c["name"][len(PREFIXES["mailout"]):] for c in cards)

    def do_adverts():
        done = []
        for town, os_ in towns.items():
            if due_again(chain_tasks(data, "adverts", town), ADVERTS_EVERY_DAYS, day)[0]:
                w.to_roy(adverts_task(town, os_, day))
                done.append(town)
        return ", ".join(done)

    def do_referrals():
        done = []
        for town, os_ in towns.items():
            if due_again(chain_tasks(data, "referral", town), REFERRAL_EVERY_DAYS, day)[0]:
                card = referral_card(data, town, os_, day)
                if card:
                    w.raise_card(card)
                    done.append(town)
        return ", ".join(done)

    def do_viewings():
        done, rows, handed = [], [], set()
        for town, os_ in sorted(towns.items(), key=lambda kv: -sum(o["rooms"] for o in kv[1])):
            mine = chain_tasks(data, "viewings", town)
            if any(created_day(t) == day for t in mine):
                continue          # one list per town per day; today's new people go tomorrow
            held = suppressed(data)
            fresh = [l for l in data["leads"] if not is_legacy(l) and l["id"] not in handed
                     and email_of(l["fields"].get(L["email"])) not in held
                     and sel(l["fields"].get(L["stage"])) == "Qualified" and town in lead_towns(lead_areas(l))]
            recent = [t for t in mine if (day - created_day(t)).days < PAST_APPLICANT_TASK_EVERY_DAYS]
            past = [] if recent else pick_past_applicants(data, town, exclude=handed)
            if not fresh and not past:
                continue
            tid = w.to_roy(viewings_task(data, town, os_, fresh, past, day))
            for l in fresh:
                rows.append({"id": l["id"], "fields": {L["stage"]: "With Roy", L["royTask"]: [tid],
                                                       L["lastContacted"]: day.isoformat()}})
            for l in past:
                rows.append({"id": l["id"], "fields": {L["royTask"]: [tid]}})
            handed |= {l["id"] for l in fresh + past}
            done.append(f"{town} ({len(fresh)} new, {len(past)} past)")
        w.patch_leads(rows)
        return ", ".join(done)

    def do_keepwarm():
        if due_again(chain_tasks(data, "keepwarm"), KEEPWARM_EVERY_DAYS, day)[0]:
            card = keepwarm_card(data, day)
            if card:
                w.raise_card(card)
                return "raised"
        return ""

    def do_settle():
        lead_rows, ref_rows, task_rows = [], [], []
        for t in data["tasks"]:
            f = t["fields"]
            notes_text = str(f.get(TK["notes"]) or "")
            m = SENT_RE.search(notes_text)
            ids = IDS_RE.search(notes_text)
            if not m or SETTLED_MARK in notes_text or not ids:
                continue
            sent = datetime.strptime(m.group(1), "%d %b %Y").date().isoformat()
            rid = [x.strip() for x in ids.group(1).split(",") if x.strip()]
            name = str(f.get(TK["name"]) or "")
            if name.startswith(PREFIXES["mailout"]):
                ref_rows += [{"id": x, "fields": {R["lastEmailed"]: sent}} for x in rid]
            elif name.startswith(PREFIXES["keepwarm"]):
                lead_rows += [{"id": x, "fields": {L["lastContacted"]: sent}} for x in rid]
            task_rows.append({"id": t["id"], "fields": {TK["notes"]: notes_text.rstrip() + f"\n\n{SETTLED_MARK} {fmt_day(day)}"}})
        w.patch(T_REFS, ref_rows, "referrer(s)")
        w.patch_leads(lead_rows)
        w.patch(T_TASKS, task_rows, "sent card(s) settled")
        return f"{len(task_rows)} sent card(s) settled" if task_rows else ""

    def do_convert():
        tenants = [t for t in data["tenants"] if sel(t["fields"].get(TN["status"])) in ("Active", "Pending")]
        rows = []
        for l in data["leads"]:
            f = l["fields"]
            if sel(f.get(L["stage"])) not in ("Qualified", "With Roy", "Past applicant", "New"):
                continue
            keys = {digits(f.get(L["phone"])), email_of(f.get(L["email"]))} - {""}
            for t in tenants:
                tf = t["fields"]
                tkeys = {digits(tf.get(TN["phone"])), email_of(tf.get(TN["email"]))} - {""}
                if keys & tkeys and (parse_day(t.get("createdTime")) or day) >= (created_day(l) or day) - timedelta(days=1):
                    fields = {L["stage"]: "Became tenant", L["tenant"]: [t["id"]],
                              L["screening"]: f"{fmt_day(day)}: became a tenant ({tf.get(TN['name'])})"}
                    if links(f.get(L["referredTenant"])):
                        fields[L["bonus"]] = "Due"
                    rows.append({"id": l["id"], "fields": fields})
                    f.update(fields)
                    break
        w.patch_leads(rows)
        return f"{len(rows)} became tenants" if rows else ""

    def do_bonus():
        tenants = {t["id"]: t["fields"] for t in data["tenants"]}
        rows = []
        for l in data["leads"]:
            first = bonus_due(data, l)
            if not first:
                continue
            f = l["fields"]
            ref = tenants.get(links(f.get(L["referredTenant"]))[0]) or {}
            new = next((str(tenants.get(x, {}).get(TN["name"]) or "") for x in links(f.get(L["tenant"]))), "")
            w.bonus_row(l, str(ref.get(TN["name"]) or "tenant"), new, first, day)
            rows.append({"id": l["id"], "fields": {L["bonus"]: "On payment run"}})
        w.patch_leads(rows)
        return f"{len(rows)} bonus(es) listed" if rows else ""

    def do_archive():
        rows = []
        for l in data["leads"]:
            if sel(l["fields"].get(L["stage"])) not in QUALIFIED_STAGES:
                continue
            heard = heard_day(l)
            if heard and (day - heard).days >= ARCHIVE_AFTER_DAYS:
                rows.append({"id": l["id"], "fields": {L["stage"]: "Archived", L["screening"]:
                             f"{fmt_day(day)}: archived, nothing heard for {ARCHIVE_AFTER_DAYS} days"}})
        w.patch_leads(rows)
        return f"{len(rows)} archived" if rows else ""

    fns = dict(zip(STEPS, (do_replies, do_screen, do_mailouts, do_adverts, do_referrals, do_viewings,
                           do_keepwarm, do_settle, do_convert, do_bonus, do_archive)))
    for label in STEPS:
        if only in (None, label):
            guard(label, fns[label])
    return opens, notes, failures


def summary(mon, failures):
    bad = [s for s in mon["steps"] if s["state"] in ("fail", "warn")]
    head = ("Working: every step on time." if not bad and not failures else
            f"{len([s for s in bad if s['state'] == 'fail'])} step(s) failing, "
            f"{len([s for s in bad if s['state'] == 'warn'])} to watch.")
    lines = [head] + [f"{s['label']}: {s['note']}" for s in bad] + [f"Run error, {f}" for f in failures]
    return "\n".join(lines)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("cmd", choices=["run", "openings", "status"])
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--only", choices=STEPS, help="run one step (a manual re-run or a test); no status row")
    a = ap.parse_args(argv)
    day = today_london()
    data = load(day)
    if a.cmd == "openings":
        print(json.dumps(openings(data, day), indent=2))
        return 0
    if a.cmd == "status":
        print(json.dumps(monitor(data, day, openings(data, day), []), indent=2))
        return 0
    w = Writer(a.dry_run)
    opens, notes, failures = run(data, day, w, only=a.only)
    if a.only:
        print(json.dumps({"only": a.only, "dryRun": a.dry_run, "plan": w.plan, "notes": notes,
                          "failures": failures}, indent=2))
        return 1 if failures else 0
    if not a.dry_run:
        data = load(day)          # the monitor reads what the run wrote, not what it meant to write
    mon = monitor(data, day, opens, notes + [f"ERROR {f}" for f in failures])
    failed = bool(failures) or mon["worst"] == "fail"
    try:
        w.status_row(mon, summary(mon, failures), failed)
    except Exception as exc:                          # noqa: BLE001 — the row is the monitor; say so loudly
        failures.append(f"status row: {str(exc)[:300]}")
    print(json.dumps({"dryRun": a.dry_run, "plan": w.plan, "notes": notes, "failures": failures,
                      "worst": mon["worst"], "steps": [(s["key"], s["state"], s["note"]) for s in mon["steps"]]},
                     indent=2))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
