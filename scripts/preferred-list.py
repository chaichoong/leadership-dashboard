#!/usr/bin/env python3
"""preferred-list.py — the one door for reading and writing the Preferred Products list.

WHY THIS EXISTS (Kevin, 11 Nov 2026). Kevin approved a "preferred list" of the
products and materials bought for his rental properties: what we buy, the rules
for buying it, who we bought it from, at what full price. Every sourcing search
starts from this list as a BASELINE (never a shortcut: the market is searched
again every time), the list is written after each approved buy, and every priced
row is re-priced about once a month.

Airtable: base appnqjDpqDniH3IRl, table "Preferred Products" (tblBHcZzWHrcW5rLU).
Every read and write here uses field NAMES, never ids, on both sides. No typecast:
select values are written exactly as the table holds them.

Commands:
  list [--item TEXT] [--json]        the rows; --item prints the BASELINE for one item
  record --task rec.. --item ".." --bought-as new|second-hand|not-bought [...]
                                     upsert one row after an approved buy (or store the
                                     item and its rules before anything is bought)
  prefer --key K --task rec.. --price N --supplier S --link URL [...]
                                     set the option preferred on review (the four Preferred
                                     fields) of a BOUGHT row; the last-buy fields are only
                                     ever written by a `record` buy
  checked --key K --result TEXT      stamp a row as re-priced
  has-row --task rec..               did this task buy a row? (bought_rows_for_task) exit 0 yes, 1 no
  due [--apply] [--as-of DATE]       the daily clock (job `preferred-list`, 06:20): raises
                                     ONE review task when any priced row was last checked
                                     30 or more days ago, then stamps every row it named
                                     "review raised", so no row raises a second task inside
                                     30 days. The state lives on the list, not in a task search.
  selftest                           the pure-function checks, no network

Exit codes: 0 worked, 1 a read or write failed (or `due` found the list broken),
2 refused (bad input, unknown key), 4 written but a field did not stick on read-back.

Tested by tests/preferred-list.test.js. Auth: ~/.config/od/airtable_pat, never printed.
"""

import argparse
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta

try:
    from zoneinfo import ZoneInfo
    LONDON = ZoneInfo("Europe/London")
except Exception as exc:                       # noqa: BLE001 — reported, never swallowed
    sys.stderr.write("WARNING: Europe/London zone unavailable (%s); dates use local time\n" % exc)
    LONDON = None

HERE = os.path.dirname(os.path.abspath(__file__))
BASE_ID = "appnqjDpqDniH3IRl"
TABLE = "tblBHcZzWHrcW5rLU"            # Preferred Products
PAT_PATH = os.environ.get("PREFLIST_PAT_FILE") or os.path.expanduser("~/.config/od/airtable_pat")
PAGE_SIZE = 100
MAX_PAGES = 200

CATEGORIES = ("Appliance", "Furniture", "Flooring", "Fixings and consumables", "Safety", "Other")
BOUGHT_AS = {"new": "New", "second-hand": "Second-hand", "not-bought": "Not bought yet"}
BOUGHT = ("New", "Second-hand")
TASK_ID_RE = re.compile(r"^rec[A-Za-z0-9]{14}$")
REPRICE_DAYS = 30
REVIEW_MARK = "PREFLIST-REVIEW"
PREFERRED_FIELDS = ("Preferred Supplier", "Preferred Link", "Preferred Price", "Preferred Since")
SUMMARY_MAX = 220   # scripts/estate-status.py plain_tail(limit=220)
OWNER = "inbound-comms-response"

# Write-side Task field ids, checked against scripts/agent-dispatch.py AF and
# scripts/certificate_watch.py TF (js/config.js TASK_FIELDS is the source).
TF = {"name": "fldgFjGBw6bTKJFCD", "status": "fldx4qCw17UfrKpaN", "due": "fld7XP8w8kbxfETV4",
      "approver": "fldLLAG5HQPEFEfE5", "priority": "fldS21RwmwOqt71LI",
      "taskType": "fldZ2moDV2041Sobc", "estimate": "fld10VzzbiNNgRmIi",
      "desc": "fldRGhBQViKZKtkQ6"}
KEVIN_USER = "usrKkopUJSGsBhWMD"


class Refused(Exception):
    """Bad input: exit 2."""


# ── pure functions (imported by other scripts: keep the names and signatures) ──

def item_key(text):
    """Lower-case, letters and digits only, words joined by single hyphens."""
    return "-".join(re.findall(r"[a-z0-9]+", str(text or "").lower()))


def _price(fields):
    """Full Price as a float, or None when blank or not a number."""
    v = (fields or {}).get("Full Price")
    if isinstance(v, bool) or v is None or v == "":
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _day(value):
    try:
        return datetime.strptime(str(value or "")[:10], "%Y-%m-%d").date()
    except ValueError:
        return None


def _active(row):
    """Only "Retired" is not active: a blank Status counts as Active everywhere."""
    return (row.get("fields") or {}).get("Status") != "Retired"


def is_priced(row):
    f = row.get("fields") or {}
    p = _price(f)
    return _active(row) and f.get("Bought As") in BOUGHT and p is not None and p > 0


def due_rows(rows, as_of):
    """Active, bought (New or Second-hand), priced above zero, and last checked
    blank or REPRICE_DAYS or more days before as_of. A blank price is not priced."""
    out = []
    for r in rows:
        if not is_priced(r):
            continue
        checked = _day((r.get("fields") or {}).get("Last Checked"))
        # An unreadable date is treated as never checked: due, never hidden.
        if checked is None or (as_of - checked).days >= REPRICE_DAYS:
            out.append(r)
    return out


def duplicate_keys(rows):
    """Item Keys held by more than one Active row."""
    seen = {}
    for r in rows:
        if not _active(r):
            continue
        k = str((r.get("fields") or {}).get("Item Key") or "").strip()
        if k:
            seen[k] = seen.get(k, 0) + 1
    return sorted(k for k, n in seen.items() if n > 1)


def matching_rows(rows, text):
    """Rows whose key equals item_key(text), or shares at least two tokens with
    it (one token when the query has only one)."""
    q = item_key(text)
    qt = set(q.split("-")) if q else set()
    need = 1 if len(qt) == 1 else 2
    out = []
    for r in rows:
        k = str((r.get("fields") or {}).get("Item Key") or "")
        if not k or not q:
            continue
        if k == q or len(qt & set(k.split("-"))) >= need:
            out.append(r)
    return out


def money(v):
    return "%.2f" % v if isinstance(v, (int, float)) and not isinstance(v, bool) else "-"


AWAITING_PREFIX = "review raised"


def is_awaiting(row):
    """Active and stamped by a raised review that has no result yet."""
    return _active(row) and str((row.get("fields") or {}).get("Last Check Result") or "").startswith(AWAITING_PREFIX)


def awaiting_result(as_of, task_id):
    return "%s %s (task %s): awaiting result" % (AWAITING_PREFIX, as_of.isoformat(), task_id)


def bought_by(row, task_id):
    """THE one definition of "this task bought this row": the row's Source Task is
    the task and it is bought (New or Second-hand), OR a Notes line records a buy
    by the task (`<date>: bought ... (task <id>)`, written on every buy), so a later
    buy of the same item by another task never strands the first."""
    f = row.get("fields") or {}
    if f.get("Source Task") == task_id and f.get("Bought As") in BOUGHT:
        return True
    tag = "(task %s)" % task_id
    return any(": bought " in ln and tag in ln for ln in str(f.get("Notes") or "").splitlines())


def summary_line(total, priced, due, awaiting, review):
    line = ("PREFERRED LIST: %d item(s) on the list, %d priced, %d due for a re-price, %d awaiting a "
            "result, review task: %s" % (total, priced, due, awaiting, review))
    return line[:SUMMARY_MAX]


def review_task_fields(due, as_of):
    """The create payload (Task field ids) for the one monthly review task."""
    lines = []
    for r in due:
        f = r.get("fields") or {}
        lines.append("- %s | %s | last price £%s | %s | last checked %s" % (
            f.get("Item Key", ""), f.get("Item", ""), money(_price(f)),
            f.get("Supplier or Seller") or "no supplier", f.get("Last Checked") or "never"))
    desc = ("%s %s\n%s\n\nFor each item search the market again (the Sourcing section of your agent "
            "file), then stamp it with: python3 scripts/preferred-list.py checked --key <key> "
            "--result \"<no change | cheaper: £x at y, link>\". Submit ONE card only if something "
            "is cheaper or better; if nothing is, say so in a report that needs no decision."
            % (REVIEW_MARK, as_of.strftime("%Y-%m"), "\n".join(lines)))
    name = "PREFERRED LIST: monthly re-price, %d item(s) (%s)" % (len(due), as_of.strftime("%b %Y"))
    return {TF["name"]: name[:100], TF["status"]: "Today", TF["due"]: as_of.isoformat(),
            TF["approver"]: {"id": KEVIN_USER}, TF["priority"]: "Medium",
            TF["taskType"]: "Research", TF["estimate"]: "45 min", TF["desc"]: desc}


# ── the network: every Airtable call goes through api() (tests replace it) ──

def _pat():
    with open(PAT_PATH) as fh:
        return fh.read().strip()


def api(method, path, body=None):
    url = "https://api.airtable.com/v0/%s%s" % (BASE_ID, path)
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        "Authorization": "Bearer %s" % _pat(), "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as e:
        raise RuntimeError("Airtable %s %s -> HTTP %d: %s" % (
            method, path.split("?")[0], e.code, e.read().decode("utf-8", "replace")[:300])) from None
    except (urllib.error.URLError, OSError, ValueError) as e:
        raise RuntimeError("Airtable %s %s failed: %s" % (method, path.split("?")[0], e)) from None


def list_records(table, formula=None, fields=None):
    """Every row, paginated to the end, keyed by field NAME. A reply with no
    `records` list is an ERROR (CLAUDE.md, finding 20261104-phase-2-1187), never
    an empty table."""
    rows, offset, pages = [], None, 0
    while True:
        q = [("pageSize", str(PAGE_SIZE))]
        if formula:
            q.append(("filterByFormula", formula))
        for f in fields or []:
            q.append(("fields[]", f))
        if offset:
            q.append(("offset", offset))
        page = api("GET", "/%s?%s" % (table, urllib.parse.urlencode(q)))
        if not isinstance(page, dict) or not isinstance(page.get("records"), list):
            raise RuntimeError("the %s read returned no records list (%s); a reply with no records "
                               "is an error, never an empty result" % (
                                   table, ", ".join(sorted(page)) if isinstance(page, dict)
                                   else type(page).__name__))
        rows.extend(page["records"])
        pages += 1
        offset = page.get("offset")
        if not offset:
            return rows
        if pages >= MAX_PAGES:
            raise RuntimeError("the %s read did not finish after %d pages" % (table, MAX_PAGES))


def read_rows():
    """Every Preferred Products row as {"id", "fields" by name}. Raises RuntimeError."""
    out = []
    for r in list_records(TABLE):
        if not isinstance(r, dict) or not r.get("id"):
            raise RuntimeError("the Preferred Products read returned a row with no id")
        out.append({"id": r["id"], "fields": r.get("fields") or {}})
    return out


def rows_for_task(task_id):
    return [r for r in read_rows() if (r.get("fields") or {}).get("Source Task") == task_id]


def bought_rows_for_task(task_id):
    """Rows this task bought (see bought_by). Raises RuntimeError on a failed read.
    The close gate calls this."""
    return [r for r in read_rows() if bought_by(r, task_id)]


def today_london():
    return (datetime.now(LONDON) if LONDON else datetime.now()).date()


def _gate(fields, flags):
    """scripts/create-agent-task.py, the duplicate gate (same route as certificate_watch.py)."""
    cmd = [sys.executable, os.path.join(HERE, "create-agent-task.py"), "create",
           "--owner", OWNER, "--fields-json", json.dumps(fields)] + list(flags)
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=240)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return False, {"action": "error", "why": str(exc)[:200]}
    lines = [ln for ln in r.stdout.splitlines() if ln.strip().startswith("{")]
    try:
        out = json.loads(lines[-1]) if lines else {}
    except ValueError:
        out = {}
    if r.returncode != 0:
        out = dict(out, action=out.get("action") or "error", exit=r.returncode,
                   why=(out.get("reason") or r.stderr.strip()[-300:] or "no output"))
    return r.returncode == 0, out


def gate_create(fields, apply):
    """Dry run first, then the real create, forced (as certificate_watch.gate_create):
    a fold into some other task would hide the review in the wrong place. A review
    already raised is kept from repeating by the stamps on the rows, not here."""
    ok, out = _gate(fields, ["--dry-run"])
    if not ok:
        return ok, out
    if not apply:
        return True, {"action": "created", "taskId": "(dry run)", "dryRun": True}
    ok, out = _gate(fields, ["--force"])
    if ok and out.get("action") == "updated":
        return False, dict(out, why="the gate folded the review into %r after its dry run said create"
                           % str(out.get("matchedName") or "")[:90])
    return ok, out


# ── writes ──

def _same(sent, got):
    if sent is None:                       # a field we cleared reads back absent or empty
        return got is None or got == ""
    if isinstance(sent, (int, float)) and not isinstance(sent, bool):
        try:
            return got is not None and abs(float(got) - float(sent)) < 0.005
        except (TypeError, ValueError):
            return False
    return str(got if got is not None else "").strip() == str(sent).strip()


def write_and_verify(row_id, fields):
    """POST (row_id None) or PATCH, then read the table back and compare every
    field sent. Returns (row_id, [fields that did not stick])."""
    if row_id:
        reply = api("PATCH", "/%s" % TABLE, {"records": [{"id": row_id, "fields": fields}]})
    else:
        reply = api("POST", "/%s" % TABLE, {"records": [{"fields": fields}]})
    recs = reply.get("records") if isinstance(reply, dict) else None
    if not isinstance(recs, list) or not recs or not recs[0].get("id"):
        raise RuntimeError("the write returned no record id")
    row_id = recs[0]["id"]
    back = next((r for r in read_rows() if r["id"] == row_id), None)
    if back is None:
        return row_id, ["(the row itself: %s is not in the table on read-back)" % row_id]
    bad = [k for k, v in fields.items() if not _same(v, back["fields"].get(k))]
    return row_id, bad


def _validate_task(task):
    if not TASK_ID_RE.match(task or ""):
        raise Refused("task id %r is not rec plus 14 letters or digits" % task)


def _validate_link(link):
    if not re.match(r"^https?://\S+$", link or ""):
        raise Refused("link %r is not an http(s) address" % link)


def _validate_price(price):
    if price is None or not price > 0:
        raise Refused("price must be above zero (got %r)" % price)


def _one_active(rows, key):
    hits = [r for r in rows if _active(r) and (r.get("fields") or {}).get("Item Key") == key]
    if len(hits) > 1:
        raise Refused("%d Active rows hold the key %s; fix the duplicate first" % (len(hits), key))
    return hits[0] if hits else None


def _valid_on(on, today, flag):
    """A YYYY-MM-DD date no later than today, or Refused."""
    d = _day(on)
    if d is None or len(str(on)) != 10:
        raise Refused("%s %r is not YYYY-MM-DD" % (flag, on))
    if d > today:
        raise Refused("%s %s is after today (%s)" % (flag, on, today.isoformat()))
    return on


def _append(notes, line):
    notes = str(notes or "").rstrip()
    return (notes + "\n" + line) if notes else line


def plan_record(rows, a, today):
    """(row_id or None, fields, key). Pure apart from its inputs. Raises Refused.

    A BUY (new, second-hand) writes the buy and appends `<date>: bought <As> £<p>
    from <supplier> (task <id>)` to Notes. NOT-BOUGHT stores an item's rules and
    nothing else: on an existing row it writes only Item (when blank), Buying Rules,
    Category and a Notes line, never the task, supplier, link, price, Bought As or
    dates, so it can neither un-buy a row nor make another task read as its buyer."""
    _validate_task(a.task)
    if a.bought_as not in BOUGHT_AS:
        raise Refused("bought-as must be one of %s" % ", ".join(BOUGHT_AS))
    if a.category is not None and a.category not in CATEGORIES:
        raise Refused("category %r is not one of %s" % (a.category, ", ".join(CATEGORIES)))
    key = item_key(a.key or a.item)
    if not key:
        raise Refused("the item %r gives an empty key" % a.item)
    existing = _one_active(rows, key)
    old = (existing or {}).get("fields") or {}
    stamp = today.isoformat()
    if a.bought_as == "not-bought":
        given = [flag for flag, v in (("--price", a.price), ("--supplier", a.supplier), ("--link", a.link),
                                      ("--cashback", a.cashback), ("--bought-on", a.bought_on)) if v is not None]
        if given:
            raise Refused("not-bought stores rules only; it takes no %s" % ", ".join(given))
        fields = {}
        if a.rules is not None:
            fields["Buying Rules"] = a.rules.strip()
        if a.category is not None:
            fields["Category"] = a.category
        if existing:
            if not str(old.get("Item") or "").strip():
                fields["Item"] = a.item.strip()
            fields["Notes"] = _append(old.get("Notes"), "%s: buying rules stored from task %s." % (stamp, a.task))
            return existing["id"], fields, key
        fields.update({"Item": a.item.strip(), "Item Key": key, "Status": "Active",
                       "Bought As": BOUGHT_AS["not-bought"], "Source Task": a.task})
        return None, fields, key
    _validate_price(a.price)
    if not (a.supplier or "").strip():
        raise Refused("a buy needs --supplier")
    _validate_link(a.link)
    on = _valid_on(a.bought_on or stamp, today, "--bought-on")
    price, supplier, bought_as = round(float(a.price), 2), a.supplier.strip(), BOUGHT_AS[a.bought_as]
    fields = {"Item": a.item.strip(), "Item Key": key, "Source Task": a.task, "Status": "Active",
              "Bought As": bought_as, "Full Price": price, "Supplier or Seller": supplier, "Link": a.link,
              "Last Bought": on, "Last Checked": on,
              # A buy is the newest check: the result must never keep an older review's words.
              "Last Check Result": "bought %s £%s from %s (task %s)" % (bought_as, money(price), supplier, a.task)}
    if a.cashback:
        fields["Cashback"] = a.cashback.strip()
    if a.rules is not None:
        fields["Buying Rules"] = a.rules.strip()
    if a.category is not None:
        fields["Category"] = a.category
    line = "%s: bought %s £%s from %s (task %s)" % (on, bought_as, money(price), supplier, a.task)
    if existing:
        # The buy is now the price to beat. An option preferred on an earlier review is history
        # (it stays in Notes), so clear it rather than compare dates: whichever of a buy and a
        # review is written last is the one the row shows.
        for k in PREFERRED_FIELDS:
            if old.get(k) not in (None, ""):
                fields[k] = None
        line += ". Was £%s, %s, from %s." % (money(_price(old)), old.get("Bought As") or "no Bought As",
                                             old.get("Supplier or Seller") or "no supplier")
    fields["Notes"] = _append(old.get("Notes"), line)
    return (existing["id"] if existing else None), fields, key


def cmd_record(a):
    today = today_london()
    try:
        rows = read_rows()
        row_id, fields, key = plan_record(rows, a, today)
    except Refused as exc:
        print("ERROR: %s" % exc)
        return 2
    except RuntimeError as exc:
        print("ERROR: %s" % exc)
        return 1
    action = "updated" if row_id else "created"
    price = money(fields.get("Full Price"))
    shown = fields.get("Bought As") or "(Bought As unchanged)"
    if a.dry_run:
        print(json.dumps({"dryRun": True, "action": action, "rowId": row_id, "fields": fields}, indent=1))
        print("DRY RUN: would record %s %s %s £%s %s" % (action, row_id or "(new row)", key, price, shown))
        return 0
    try:
        row_id, bad = write_and_verify(row_id, fields)
    except RuntimeError as exc:
        print("ERROR: %s" % exc)
        return 1
    if bad:
        print("ERROR: written to %s but these fields did not stick on read-back: %s" % (row_id, ", ".join(bad)))
        return 4
    print("RECORDED: %s %s %s £%s %s" % (action, row_id, key, price, shown))
    return 0


def plan_prefer(rows, a, today):
    """(row_id, fields, key, old_price). Raises Refused."""
    _validate_task(a.task)
    _validate_price(a.price)
    if not (a.supplier or "").strip():
        raise Refused("prefer needs --supplier")
    _validate_link(a.link)
    on = _valid_on(a.on or today.isoformat(), today, "--on")
    key = item_key(a.key)
    row = _one_active(rows, key)
    if not row:
        raise Refused("no Active row holds the key %s" % key)
    f = row["fields"]
    # Only a real `record` buy makes a row bought (it sets Source Task and writes the
    # Notes buy line). prefer never writes Bought As, so a review can never make a
    # rules-only row read as bought by the task that stored its rules.
    if f.get("Bought As") not in BOUGHT:
        raise Refused("prefer changes the preferred option of an item we have bought; this one has "
                      "not been bought yet")
    # The last-buy fields (Supplier or Seller, Link, Full Price, Bought As, Last Bought,
    # Cashback) describe the LAST REAL BUY and only a `record` buy writes them. The
    # option approved on a review lives in the four Preferred fields.
    last, new, sup = money(_price(f)), money(round(float(a.price), 2)), a.supplier.strip()
    fields = {"Preferred Supplier": sup, "Preferred Link": a.link, "Preferred Price": round(float(a.price), 2),
              "Preferred Since": on, "Last Checked": on,
              "Last Check Result": "adopted on review (%s): £%s at %s" % (a.task, new, sup)}
    fields["Notes"] = _append(f.get("Notes"), "%s: preferred option set on review (%s): £%s at %s; last buy "
                              "stays £%s from %s" % (on, a.task, new, sup, last,
                                                      f.get("Supplier or Seller") or "no supplier"))
    return row["id"], fields, key, last


def cmd_prefer(a):
    try:
        row_id, fields, key, old = plan_prefer(read_rows(), a, today_london())
    except Refused as exc:
        print("ERROR: %s" % exc)
        return 2
    except RuntimeError as exc:
        print("ERROR: %s" % exc)
        return 1
    line = "%s %s £%s %s (last buy £%s unchanged)" % (row_id, key, money(fields["Preferred Price"]),
                                                     fields["Preferred Supplier"], old)
    if a.dry_run:
        print(json.dumps({"dryRun": True, "rowId": row_id, "fields": fields}, indent=1))
        print("DRY RUN: would set PREFERRED: %s" % line)
        return 0
    try:
        row_id, bad = write_and_verify(row_id, fields)
    except RuntimeError as exc:
        print("ERROR: %s" % exc)
        return 1
    if bad:
        print("ERROR: written to %s but these fields did not stick on read-back: %s" % (row_id, ", ".join(bad)))
        return 4
    print("PREFERRED: %s" % line)
    return 0


def cmd_checked(a):
    key = item_key(a.key)
    try:
        today = today_london()
        on = _valid_on(a.on or today.isoformat(), today, "--on")
        row = _one_active(read_rows(), key)
    except Refused as exc:
        print("ERROR: %s" % exc)
        return 2
    except RuntimeError as exc:
        print("ERROR: %s" % exc)
        return 1
    if not row:
        print("ERROR: no Active row holds the key %s" % key)
        return 2
    try:
        row_id, bad = write_and_verify(row["id"], {"Last Checked": on, "Last Check Result": a.result.strip()})
    except RuntimeError as exc:
        print("ERROR: %s" % exc)
        return 1
    if bad:
        print("ERROR: written to %s but these fields did not stick on read-back: %s" % (row_id, ", ".join(bad)))
        return 4
    print("CHECKED: %s %s %s" % (row_id, key, on))
    return 0


def cmd_has_row(a):
    if not TASK_ID_RE.match(a.task or ""):
        print("ERROR: task id %r is not rec plus 14 letters or digits" % a.task)
        return 2
    try:
        hits = bought_rows_for_task(a.task)
    except RuntimeError as exc:
        print("ERROR: %s" % exc)
        return 2
    if hits:
        print("%s (bought by %s)" % (" ".join(r["id"] for r in hits), a.task))
        return 0
    print("NO ROW for %s (no row on the list was bought by this task)" % a.task)
    return 1


def _row_lines(r):
    """The last buy, then the option preferred on review (when set), then the last check."""
    f = r.get("fields") or {}
    lines = ["%s | %s | £%s | %s | %s | %s | last bought %s | %s | rules: %s" % (
        f.get("Item Key", ""), f.get("Item", ""), money(_price(f)), f.get("Bought As") or "-",
        f.get("Supplier or Seller") or "-", f.get("Link") or "-", f.get("Last Bought") or "-",
        f.get("Status") or "-", f.get("Buying Rules") or "-")]
    pref = _price({"Full Price": f.get("Preferred Price")})
    # A buy clears the Preferred fields (plan_record), so a set price is always newer than the last buy.
    if pref is not None:
        lines.append("PREFERRED ON REVIEW (%s): £%s at %s %s" % (
            f.get("Preferred Since") or "no date", money(pref), f.get("Preferred Supplier") or "-",
            f.get("Preferred Link") or "-"))
    lines.append("last checked %s (%s)" % (f.get("Last Checked") or "never",
                                         f.get("Last Check Result") or "no result recorded"))
    return lines


def cmd_list(a):
    try:
        rows = read_rows()
    except RuntimeError as exc:
        print("ERROR: %s" % exc)
        return 1
    if a.item is not None:
        rows = matching_rows(rows, a.item)
        if not rows:
            print("BASELINE: none on the list for %s" % a.item)
            return 0
    if a.json:
        print(json.dumps(rows, indent=1))
        return 0
    if a.item is not None:
        print("BASELINE:")
    for r in rows:
        print("\n".join(_row_lines(r)))
    return 0


def cmd_due(a):
    if a.as_of:
        as_of = _day(a.as_of)
        if as_of is None:
            print("ERROR: --as-of %r is not YYYY-MM-DD" % a.as_of)
            return 2
    else:
        as_of = today_london()
    try:
        rows = read_rows()
    except RuntimeError as exc:
        print("ERROR: %s" % exc)
        return 1
    if not rows:
        print("ERROR: Preferred Products read 0 rows; the list is never empty once seeded")
        return 1
    dups = duplicate_keys(rows)
    if dups:
        print("ERROR: duplicate Item Key(s): %s" % ", ".join(dups))
        return 1
    active = [r for r in rows if _active(r)]
    priced = [r for r in rows if is_priced(r)]
    due = due_rows(rows, as_of)
    report = {"asOf": as_of.isoformat(), "apply": bool(a.apply), "rows": len(rows),
              "active": len(active), "priced": len(priced),
              "due": [{"id": r["id"], "key": r["fields"].get("Item Key"),
                       "lastChecked": r["fields"].get("Last Checked")} for r in due]}
    review, code = "none needed", 0
    if due:
        fields = review_task_fields(due, as_of)
        report["wouldRaise"] = fields[TF["name"]]
        ok, out = gate_create(fields, a.apply)
        task_id = str(out.get("taskId") or "")
        if ok and a.apply and not TASK_ID_RE.match(task_id):
            ok, out = False, {"why": "the gate said created but returned no task id (%r)" % task_id}
        if not ok:
            print("ERROR: the review task was not raised: %s" % str(out.get("why") or out)[:300])
            review, code = "not raised (gate refused)", 1
        elif not a.apply:
            review = "would raise (dry run)"
        else:
            review = "raised %s" % task_id
            # The state lives on the list: every row the task names is stamped, so
            # tomorrow it is not due and no row raises a second task inside 30 days.
            stamp = {"Last Checked": as_of.isoformat(), "Last Check Result": awaiting_result(as_of, task_id)}
            for r in due:
                try:
                    _, bad = write_and_verify(r["id"], stamp)
                except RuntimeError as exc:
                    bad = [str(exc)[:200]]
                if bad:
                    print("ERROR: review task %s raised but row %s (%s) was not stamped: %s" % (
                        task_id, r["id"], r["fields"].get("Item Key"), ", ".join(bad)))
                    code = 1
                else:
                    r["fields"].update(stamp)
    if a.json:
        print(json.dumps(report, indent=1))
    else:
        for d in report["due"]:
            print("DUE: %s (last checked %s)" % (d["key"], d["lastChecked"] or "never"))
    print(summary_line(len(active), len(priced), len(due), sum(1 for r in rows if is_awaiting(r)), review))
    return code


# ── selftest ──

def _row(rid, key, status="Active", bought="Second-hand", price=70.0, checked=None, **extra):
    f = {"Item": key, "Item Key": key, "Bought As": bought}
    if status:
        f["Status"] = status
    if price is not None:
        f["Full Price"] = price
    if checked:
        f["Last Checked"] = checked
    f.update(extra)
    return {"id": rid, "fields": f}


def selftest():
    checks = []

    def check(label, ok):
        checks.append((label, bool(ok)))

    T = date(2026, 12, 11)
    check("item_key", item_key("Fridge freezer, full height") == "fridge-freezer-full-height")
    check("item_key blank", item_key("  ") == "")
    rows = [_row("rec1", "a", checked="2026-11-12"), _row("rec2", "b", checked="2026-11-11"),
            _row("rec3", "c", checked="2026-11-10"), _row("rec4", "d"),
            _row("rec5", "e", price=None), _row("rec6", "f", bought="Not bought yet", price=None),
            _row("rec7", "g", status="Retired"), _row("rec8", "h", price=0)]
    due = [r["id"] for r in due_rows(rows, T)]
    check("29 days not due", "rec1" not in due)
    check("30 days due", "rec2" in due)
    check("31 days due", "rec3" in due)
    check("never checked due", "rec4" in due)
    check("blank price not due", "rec5" not in due)
    check("not bought not due", "rec6" not in due)
    check("retired not due", "rec7" not in due)
    check("zero price not due", "rec8" not in due)
    check("blank status due", [r["id"] for r in due_rows([_row("recB", "i", status=None)], T)] == ["recB"])
    check("duplicate keys", duplicate_keys(rows + [_row("rec9", "a"), _row("recA", "b", status="Retired")]) == ["a"])
    nb = _row("recC", "j", bought="Not bought yet", price=None, **{"Source Task": "recT"})
    check("not bought is not bought by its task", not bought_by(nb, "recT"))
    check("bought by notes line", bought_by(_row("recD", "k", **{"Source Task": "recU",
          "Notes": "2026-11-01: bought New £5.00 from S (task recT)"}), "recT"))
    check("match two tokens", len(matching_rows([_row("r", "fridge-freezer-full-height")], "freezer fridge")) == 1)
    check("match one token needs two", not matching_rows([_row("r", "fridge-freezer-full-height")], "fridge door"))
    check("match single token", len(matching_rows([_row("r", "fridge-freezer-full-height")], "fridge")) == 1)
    check("summary length", len(summary_line(10 ** 6, 10 ** 6, 10 ** 6, 10 ** 6, "x" * 300)) <= SUMMARY_MAX)
    bad = [label for label, ok in checks if not ok]
    if bad:
        print("SELFTEST FAILED: %s" % ", ".join(bad))
        return 1
    print("SELFTEST: %d checks passed" % len(checks))
    return 0


def build_parser():
    p = argparse.ArgumentParser(prog="preferred-list.py", description="The Preferred Products list.")
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("list")
    s.add_argument("--item")
    s.add_argument("--json", action="store_true")
    s = sub.add_parser("record")
    s.add_argument("--task", required=True)
    s.add_argument("--item", required=True)
    s.add_argument("--key")
    s.add_argument("--bought-as", required=True)
    s.add_argument("--price", type=float)
    s.add_argument("--supplier")
    s.add_argument("--link")
    s.add_argument("--rules")
    s.add_argument("--category")
    s.add_argument("--cashback")
    s.add_argument("--bought-on")
    s.add_argument("--dry-run", action="store_true")
    s = sub.add_parser("prefer")
    s.add_argument("--key", required=True)
    s.add_argument("--task", required=True)
    s.add_argument("--price", type=float, required=True)
    s.add_argument("--supplier", required=True)
    s.add_argument("--link", required=True)
    s.add_argument("--on")
    s.add_argument("--dry-run", action="store_true")
    s = sub.add_parser("checked")
    s.add_argument("--key", required=True)
    s.add_argument("--result", required=True)
    s.add_argument("--on")
    s = sub.add_parser("has-row")
    s.add_argument("--task", required=True)
    s = sub.add_parser("due")
    s.add_argument("--apply", action="store_true")
    s.add_argument("--as-of")
    s.add_argument("--json", action="store_true")
    sub.add_parser("selftest")
    return p


def main(argv):
    a = build_parser().parse_args(argv)
    if a.cmd == "selftest":
        return selftest()
    return {"list": cmd_list, "record": cmd_record, "prefer": cmd_prefer, "checked": cmd_checked,
            "has-row": cmd_has_row, "due": cmd_due}[a.cmd](a)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
