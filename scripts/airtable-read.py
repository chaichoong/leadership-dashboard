#!/usr/bin/env python3
"""Read-only Airtable in ONE bare python3 command, for the robots.

WHY THIS EXISTS (findings 20261013-ceo-agent-856 and 20261011-phase-2-765).

The department-head subagents are started with AGENT_ALLOWED_TOOLS, which
allows only commands that START with python3, curl or node. A head told to
"read the board" reached for `curl ... | python3 -c ...`, or for cat/ls/head to
find the token, and the robot allow list refused every one of them. On 13 and
14 Oct 2026 the 06:45 CEO huddle came back with three lanes reporting NOT
CHECKED, two days running, because no head could get a single row out of
Airtable.

A pipe is not a command that starts with python3. Neither is `$(cat file)`. So
the fix is not a wider allow list — it is one command that needs no shell glue:

    python3 scripts/airtable-read.py Tasks --formula "{Status}='Today'" --fields "Task Name,Status"

It reads the token itself, paginates every read (a missed page is how this repo
once scored a card wrong for a month), and prints JSON on stdout. Nothing else.

RULES THIS FILE KEEPS, all of them learned here the hard way:
  * NEVER print the token, not even in an error. Errors carry the HTTP status.
  * PAGINATE, always, following `offset` to the end.
  * STATE THE COUNT and fail loudly on a read that could not happen. A zero
    that might be a broken read is worse than an error, because it gets acted
    on (CLAUDE.md: "a wrong query still returns 200").
  * READ ONLY. There is no write path in this file on purpose: the robots'
    writes go through the gates in agent-dispatch.py, never through a reader.

Exit: 0 read ok, 2 could not read (token, HTTP, bad arguments).
"""

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

BASE_ID = os.environ.get("AIRTABLE_BASE_ID", "appnqjDpqDniH3IRl")
PAT_FILE = os.environ.get("AIRTABLE_PAT_FILE",
                          os.path.expanduser("~/.config/od/airtable_pat"))
API = "https://api.airtable.com/v0"
PAGE_SIZE = 100


def die(reason, detail=""):
    """Plain English on stdout as JSON, so a head can report it verbatim."""
    print(json.dumps({"ok": False, "error": reason, "detail": detail}, indent=2))
    sys.exit(2)


def token():
    try:
        with open(PAT_FILE) as f:
            pat = f.read().strip()
    except OSError as e:
        die("cannot read the Airtable token file", "%s: %s" % (PAT_FILE, e.strerror))
    if not pat:
        die("the Airtable token file is empty", PAT_FILE)
    return pat


def get(url, pat):
    req = urllib.request.Request(url, headers={"Authorization": "Bearer %s" % pat})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        # The status and Airtable's own message. Never the request headers.
        body = ""
        try:
            body = (e.read() or b"").decode("utf-8", "replace")[:300]
        except Exception:
            pass
        die("Airtable refused the read (HTTP %s)" % e.code, body)
    except urllib.error.URLError as e:
        die("cannot reach Airtable", str(e.reason))
    except Exception as e:  # never swallow: say what broke
        die("the read failed", "%s: %s" % (type(e).__name__, e))


def read_table(table, formula=None, fields=None, view=None, sort=None,
               limit=None, by_field_id=False):
    """Every matching row, paginated to the end. (rows, pages)."""
    pat = token()
    rows, offset, pages = [], None, 0
    while True:
        q = [("pageSize", str(PAGE_SIZE))]
        if formula:
            q.append(("filterByFormula", formula))
        if view:
            q.append(("view", view))
        if by_field_id:
            q.append(("returnFieldsByFieldId", "true"))
        for f in fields or []:
            q.append(("fields[]", f))
        if sort:
            q.append(("sort[0][field]", sort))
        if offset:
            q.append(("offset", offset))
        url = "%s/%s/%s?%s" % (API, BASE_ID, urllib.parse.quote(table),
                               urllib.parse.urlencode(q))
        page = get(url, pat)
        rows.extend(page.get("records") or [])
        pages += 1
        offset = page.get("offset")
        if not offset:
            break
        if limit and len(rows) >= limit:
            break
        if pages > 200:  # a runaway offset loop is a bug, not a big table
            die("pagination did not finish", "stopped after 200 pages")
    return (rows[:limit] if limit else rows), pages


def read_record(table, rec_id):
    """One record. NOTE (CLAUDE.md): a GET by record id ignores the table in
    the URL, so this NEVER proves which table the record lives in."""
    pat = token()
    url = "%s/%s/%s/%s" % (API, BASE_ID, urllib.parse.quote(table), rec_id)
    return get(url, pat)


def read_schema():
    pat = token()
    tables, offset = [], None
    while True:
        url = "%s/meta/bases/%s/tables" % (API, BASE_ID)
        if offset:
            url += "?offset=%s" % urllib.parse.quote(offset)
        page = get(url, pat)
        tables.extend(page.get("tables") or [])
        offset = page.get("offset")
        if not offset:
            break
    return tables


def main(argv=None):
    p = argparse.ArgumentParser(
        description="Read-only Airtable reader for the robots. Prints JSON.")
    p.add_argument("table", nargs="?",
                   help="table name or id, e.g. Tasks or tblqB8b22hKBL4PF1")
    p.add_argument("--formula", help="filterByFormula, e.g. \"{Status}='Today'\"")
    p.add_argument("--fields", help="comma-separated field NAMES to return")
    p.add_argument("--view", help="read a named view instead of the whole table")
    p.add_argument("--sort", help="field name to sort by")
    p.add_argument("--limit", type=int, help="stop after this many rows")
    p.add_argument("--record", help="read ONE record id instead of a list")
    p.add_argument("--by-field-id", action="store_true",
                   help="return fields keyed by field id, not name")
    p.add_argument("--schema", action="store_true",
                   help="list the base's tables and fields instead of rows")
    p.add_argument("--count-only", action="store_true",
                   help="print just the count, not the rows")
    a = p.parse_args(argv)

    if a.schema:
        tables = read_schema()
        print(json.dumps({"ok": True, "tables": len(tables),
                          "schema": [{"id": t.get("id"), "name": t.get("name"),
                                      "fields": [f.get("name") for f in t.get("fields") or []]}
                                     for t in tables]}, indent=2))
        return 0

    if not a.table:
        die("no table given", "usage: airtable-read.py <table> [--formula F] [--fields A,B]")

    if a.record:
        rec = read_record(a.table, a.record)
        print(json.dumps({"ok": True, "record": rec}, indent=2))
        return 0

    fields = [f.strip() for f in (a.fields or "").split(",") if f.strip()]
    rows, pages = read_table(a.table, formula=a.formula, fields=fields,
                             view=a.view, sort=a.sort, limit=a.limit,
                             by_field_id=a.by_field_id)
    out = {"ok": True, "table": a.table, "count": len(rows), "pages": pages}
    if a.formula:
        out["formula"] = a.formula
    if not a.count_only:
        out["records"] = rows
    print(json.dumps(out, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
