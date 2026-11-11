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
                                     change the preferred option on review, no buy recorded
  checked --key K --result TEXT      stamp a row as re-priced
  has-row --task rec..               does a row carry this task? exit 0 yes, 1 no
  due [--apply] [--as-of DATE]       the daily clock (job `preferred-list`, 06:20): raises
                                     ONE review task when any priced row was last checked
                                     30 or more days ago and no review task is open
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
TASKS = "tblqB8b22hKBL4PF1"            # Tasks
PAT_PATH = os.environ.get("PREFLIST_PAT_FILE") or os.path.expanduser("~/.config/od/airtable_pat")
PAGE_SIZE = 100
MAX_PAGES = 200

CATEGORIES = ("Appliance", "Furniture", "Flooring", "Fixings and consumables", "Safety", "Other")
BOUGHT_AS = {"new": "New", "second-hand": "Second-hand", "not-bought": "Not bought yet"}
BOUGHT = ("New", "Second-hand")
TASK_ID_RE = re.compile(r"^rec[A-Za-z0-9]{14}$")
REPRICE_DAYS = 30
REVIEW_MARK = "PREFLIST-REVIEW"
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
    return (row.get("fields") or {}).get("Status") == "Active"


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


def summary_line(total, priced, due, review):
    line = ("PREFERRED LIST: %d item(s) on the list, %d priced, %d due for a re-price, review task: %s"
            % (total, priced, due, review))
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


_ESCAPE_RE = re.compile(r"\\([\\`*_{}\[\]()#+\-.!|>~])")


def plain_text(text):
    """Rich text back to plain: Airtable may return the marker as PREFLIST\\-REVIEW."""
    return _ESCAPE_RE.sub(r"\1", str(text or ""))


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


def today_london():
    return (datetime.now(LONDON) if LONDON else datetime.now()).date()


def open_review_tasks():
    """Open Tasks whose Description carries the review marker. The formula looks
    for the word without its hyphen (rich text may escape it); Python then checks
    the marker and the status."""
    rows = list_records(TASKS, formula="AND(FIND('PREFLIST', {Description}), {Status}!='Completed', "
                                       "{Status}!='Cancelled')",
                        fields=["Task Name", "Description", "Status"])
    out = []
    for r in rows:
        f = r.get("fields") or {}
        status = f.get("Status")
        status = status.get("name") if isinstance(status, dict) else status
        if REVIEW_MARK in plain_text(f.get("Description")) and status not in ("Completed", "Cancelled"):
            out.append(r)
    return out


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
    the open-task check has already found no review task, so a fold into some other
    task would hide the marker in the wrong place."""
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


def _assert_name_keyed(row, key):
    """A read-modify-write uses ONE key style: prove the row came back by NAME."""
    if (row.get("fields") or {}).get("Item Key") != key:
        raise RuntimeError("the row read for %s is not keyed by field name; refusing to append "
                           "to Notes" % key)


def _append(notes, line):
    notes = str(notes or "").rstrip()
    return (notes + "\n" + line) if notes else line


def plan_record(rows, a, today):
    """(row_id or None, fields, key). Pure apart from its inputs. Raises Refused."""
    _validate_task(a.task)
    if a.bought_as not in BOUGHT_AS:
        raise Refused("bought-as must be one of %s" % ", ".join(BOUGHT_AS))
    if a.category is not None and a.category not in CATEGORIES:
        raise Refused("category %r is not one of %s" % (a.category, ", ".join(CATEGORIES)))
    buying = a.bought_as != "not-bought"
    if buying:
        _validate_price(a.price)
        if not (a.supplier or "").strip():
            raise Refused("a buy needs --supplier")
        _validate_link(a.link)
    else:
        if a.price is not None:
            raise Refused("not-bought takes no price; record the buy when it happens")
        if a.link:
            _validate_link(a.link)
    key = item_key(a.key or a.item)
    if not key:
        raise Refused("the item %r gives an empty key" % a.item)
    on = a.bought_on or today.isoformat()
    if _day(on) is None:
        raise Refused("--bought-on %r is not YYYY-MM-DD" % on)
    existing = _one_active(rows, key)
    fields = {"Item": a.item.strip(), "Item Key": key, "Source Task": a.task, "Status": "Active"}
    if buying:
        fields.update({"Bought As": BOUGHT_AS[a.bought_as], "Full Price": round(float(a.price), 2),
                       "Supplier or Seller": a.supplier.strip(), "Link": a.link,
                       "Last Bought": on, "Last Checked": on})
    else:
        if a.supplier:
            fields["Supplier or Seller"] = a.supplier.strip()
        if a.link:
            fields["Link"] = a.link
        # Storing rules for an item already bought never un-buys it.
        if not existing or (existing.get("fields") or {}).get("Bought As") not in BOUGHT:
            fields["Bought As"] = BOUGHT_AS["not-bought"]
    if a.cashback:
        fields["Cashback"] = a.cashback.strip()
    if a.rules is not None:
        fields["Buying Rules"] = a.rules.strip()
    if a.category is not None:
        fields["Category"] = a.category
    if existing:
        _assert_name_keyed(existing, key)
        f = existing["fields"]
        fields["Notes"] = _append(f.get("Notes"), "%s: updated from task %s. Was £%s, %s, from %s." % (
            today.isoformat(), a.task, money(_price(f)), f.get("Bought As") or "no Bought As",
            f.get("Supplier or Seller") or "no supplier"))
        return existing["id"], fields, key
    return None, fields, key


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
    if a.bought_as is not None and a.bought_as not in ("new", "second-hand"):
        raise Refused("bought-as for prefer must be new or second-hand")
    on = a.on or today.isoformat()
    if _day(on) is None:
        raise Refused("--on %r is not YYYY-MM-DD" % on)
    key = item_key(a.key)
    row = _one_active(rows, key)
    if not row:
        raise Refused("no Active row holds the key %s" % key)
    _assert_name_keyed(row, key)
    f = row["fields"]
    old, new, sup = money(_price(f)), money(round(float(a.price), 2)), a.supplier.strip()
    fields = {"Supplier or Seller": sup, "Link": a.link, "Full Price": round(float(a.price), 2),
              "Last Checked": on,
              "Last Check Result": "adopted on review (%s): £%s at %s" % (a.task, new, sup)}
    if a.cashback:
        fields["Cashback"] = a.cashback.strip()
    if a.bought_as:
        fields["Bought As"] = BOUGHT_AS[a.bought_as]
    fields["Notes"] = _append(f.get("Notes"), "%s: preferred option changed on review (%s): was £%s at %s, "
                              "now £%s at %s" % (on, a.task, old, f.get("Supplier or Seller") or "no supplier",
                                                 new, sup))
    return row["id"], fields, key, old


def cmd_prefer(a):
    try:
        row_id, fields, key, old = plan_prefer(read_rows(), a, today_london())
    except Refused as exc:
        print("ERROR: %s" % exc)
        return 2
    except RuntimeError as exc:
        print("ERROR: %s" % exc)
        return 1
    line = "%s %s £%s -> £%s %s" % (row_id, key, old, money(fields["Full Price"]), fields["Supplier or Seller"])
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
    on = a.on or today_london().isoformat()
    if _day(on) is None:
        print("ERROR: --on %r is not YYYY-MM-DD" % on)
        return 2
    key = item_key(a.key)
    try:
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
        hits = rows_for_task(a.task)
    except RuntimeError as exc:
        print("ERROR: %s" % exc)
        return 2
    if hits:
        print(" ".join(r["id"] for r in hits))
        return 0
    print("NO ROW for %s" % a.task)
    return 1


def _row_line(r):
    f = r.get("fields") or {}
    return "%s | %s | £%s | %s | %s | %s | last bought %s | last checked %s (%s) | %s | rules: %s" % (
        f.get("Item Key", ""), f.get("Item", ""), money(_price(f)), f.get("Bought As") or "-",
        f.get("Supplier or Seller") or "-", f.get("Link") or "-", f.get("Last Bought") or "-",
        f.get("Last Checked") or "never", f.get("Last Check Result") or "no result recorded",
        f.get("Status") or "-", f.get("Buying Rules") or "-")


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
        print(_row_line(r))
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
        try:
            open_tasks = open_review_tasks()
        except RuntimeError as exc:
            print("ERROR: %s" % exc)
            return 1
        if open_tasks:
            review = "already open %s" % open_tasks[0]["id"]
        else:
            fields = review_task_fields(due, as_of)
            report["wouldRaise"] = fields[TF["name"]]
            ok, out = gate_create(fields, a.apply)
            if not ok:
                print("ERROR: the review task was not raised: %s" % str(out.get("why") or out)[:300])
                review, code = "not raised (gate refused)", 1
            elif a.apply:
                review = "raised %s" % out.get("taskId", "")
            else:
                review = "would raise (dry run)"
    if a.json:
        print(json.dumps(report, indent=1))
    else:
        for d in report["due"]:
            print("DUE: %s (last checked %s)" % (d["key"], d["lastChecked"] or "never"))
    print(summary_line(len(active), len(priced), len(due), review))
    return code


# ── selftest ──

def _row(rid, key, status="Active", bought="Second-hand", price=70.0, checked=None, **extra):
    f = {"Item": key, "Item Key": key, "Status": status, "Bought As": bought}
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
    check("duplicate keys", duplicate_keys(rows + [_row("rec9", "a"), _row("recA", "b", status="Retired")]) == ["a"])
    check("match two tokens", len(matching_rows([_row("r", "fridge-freezer-full-height")], "freezer fridge")) == 1)
    check("match one token needs two", not matching_rows([_row("r", "fridge-freezer-full-height")], "fridge door"))
    check("match single token", len(matching_rows([_row("r", "fridge-freezer-full-height")], "fridge")) == 1)
    check("summary length", len(summary_line(10 ** 6, 10 ** 6, 10 ** 6, "x" * 300)) <= SUMMARY_MAX)
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
    s.add_argument("--bought-as")
    s.add_argument("--cashback")
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
