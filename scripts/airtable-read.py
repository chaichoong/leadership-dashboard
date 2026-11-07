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
# An env override so the TESTS can drive the real CLI end to end against a
# local stub. Without it the only thing a test can reach is an internal
# function, and a test that never runs the command is theatre.
#
# LOOPBACK ONLY, and that is not belt-and-braces: this file sends the live
# Airtable token as a Bearer header on every request, so an env var that could
# name any host would be a way to post the token to one. A non-loopback value
# is ignored and said on stderr, never obeyed quietly.
def _api_base():
    raw = (os.environ.get("AIRTABLE_API") or "").strip()
    if not raw:
        return "https://api.airtable.com/v0"
    host = urllib.parse.urlparse(raw).hostname or ""
    if host in ("127.0.0.1", "::1", "localhost"):
        return raw
    print("IGNORING AIRTABLE_API=%r: only a loopback host is allowed, because "
          "this reader sends the live token as a Bearer header. Reading the "
          "real Airtable instead." % raw, file=sys.stderr)
    return "https://api.airtable.com/v0"


API = _api_base()
PAGE_SIZE = 100

# ─── A LANE NAME IS NOT A TABLE NAME ──────────────────────────────────────
#
# Findings 20261102-ceo-huddle-1163 and 20261106-phase-2-1215. The board's
# Finance lane is told to read "the Payment Run". There is no table of that
# name in the base: the list lives in Dashboard Invoices. For two working days
# the head got a bare "HTTP 403", decided that was a reason to SUBSTITUTE
# another table, and the brief Kevin reads carried "3 unpaid bills totalling
# GBP 516" with nothing saying it came from somewhere else. That is the
# "a wrong query still returns 200" failure wearing a 403: a refused read must
# never be answered by quietly reading something else.
#
# Two rules, both here because this is the one door every head reads through:
#   * A NAME WE KNOW resolves, and the output SAYS it resolved (resolvedFrom).
#     Loud, not silent — the caller can see which table the rows came from.
#   * A NAME WE DO NOT KNOW names the base's real tables in the error, so the
#     head reports the names instead of guessing one.
TABLE_ALIASES = {
    # Kevin's words for the Friday payment list -> the table that holds it.
    # Confirmed against scripts/check-data-invariants.py INVOICES
    # (tblkOTKIG2Tyiy9aM, "Dashboard Invoices (the Payment Run list)").
    "payment run": "Dashboard Invoices",
    "payment run list": "Dashboard Invoices",
    "payments": "Dashboard Invoices",
}



# Set while read_schema() is itself reading, so a schema read that fails can
# never recurse into "let me read the schema to explain this".
_RESOLVING = {"on": False}


def die(reason, detail=""):
    """Plain English on stdout as JSON, so a head can report it verbatim.

    SILENT while a resolver read is in flight. The schema read behind an error
    message, or behind a cheap count, is not the caller's read: printing its own
    failure would put TWO JSON objects on stdout and the head parses the first
    one it finds. The resolver turns the SystemExit into its own plain line."""
    if not _RESOLVING["on"]:
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


def get(url, pat, table=None):
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
        if table and e.code in (403, 404) and not _RESOLVING["on"]:
            # The commonest cause by far is a name that is not a table. Say
            # which tables DO exist, so the caller reports a name rather than
            # substituting a source of its own (findings 1163 and 1215).
            die("Airtable refused the read of table %r (HTTP %s). %s"
                % (table, e.code, real_table_hint(table)), body)
        die("Airtable refused the read (HTTP %s)" % e.code, body)
    except urllib.error.URLError as e:
        die("cannot reach Airtable", str(e.reason))
    except Exception as e:  # never swallow: say what broke
        die("the read failed", "%s: %s" % (type(e).__name__, e))


def resolve_table(table):
    """(name to read, the name asked for when it was an alias).

    Never silent: the caller prints `resolvedFrom` so a reader of the output can
    see the rows did not come from the name in the request."""
    key = " ".join((table or "").split()).lower()
    target = TABLE_ALIASES.get(key)
    if target and target.lower() != key:
        return target, table
    return table, None


def real_table_hint(asked):
    """The base's real table names, for an error about a name that is not one.

    A failed schema read is said plainly and never guessed at: the point of
    this line is to replace a guess, so it must not make one."""
    _RESOLVING["on"] = True
    try:
        tables = read_schema()
    except SystemExit:
        return ("The base's table list could not be read, so the real names "
                "are NOT CHECKED. Do NOT read a different table instead.")
    finally:
        _RESOLVING["on"] = False
    names = sorted(t.get("name") or "" for t in tables)
    close = [n for n in names
             if n and (n.lower() in (asked or "").lower()
                       or (asked or "").lower() in n.lower())]
    line = "The base's tables are: %s." % ", ".join(n for n in names if n)
    if close:
        line += " Closest by name: %s." % ", ".join(close)
    line += (" Read one of those by name, or say NOT CHECKED. Never answer a "
             "refused read by reading a different table.")
    return line


def primary_field(table):
    """The table's first field name, or None when the schema cannot be read.

    Used to make a count cheap: one small field per row instead of every field
    (finding 20261102-ceo-huddle-1163 — a Transactions --count-only ran past
    120 s and the Finance lane went NOT CHECKED for a second day)."""
    _RESOLVING["on"] = True
    try:
        tables = read_schema()
    except SystemExit:
        return None
    finally:
        _RESOLVING["on"] = False
    for t in tables:
        if (t.get("name") or "").lower() == (table or "").lower() \
                or t.get("id") == table:
            for f in t.get("fields") or []:
                if f.get("name"):
                    return f["name"]
    return None


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
        page = get(url, pat, table=table)
        # NO RECORDS KEY IS AN ERROR, NOT AN EMPTY TABLE (4 Nov 2026, finding
        # 20261104-phase-2-1187). `page.get("records") or []` reads a reply that
        # carries no records at all as zero rows, and a zero is what gets acted
        # on: on 4 Nov a dedupe read whose reply had no records key was read as
        # "no duplicates" and nearly created one. A reply we cannot find rows in
        # is NOT CHECKED, loudly, whatever its HTTP status was.
        if not isinstance(page, dict) or not isinstance(page.get("records"), list):
            die("the read returned no records key",
                "Airtable replied with %s. A reply with no records list is an "
                "error, never an empty result." % (
                    ", ".join(sorted(page.keys())) if isinstance(page, dict)
                    else type(page).__name__))
        rows.extend(page["records"])
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


def selftest():
    """Drive the real read_table over a stubbed `get`. No network, no token."""
    g, failed, checks = globals(), [], 0
    saved = (g["get"], g["token"])
    saved_get = g["get"]
    g["token"] = lambda: "stub"

    def run(pages):
        """pages: the replies `get` hands back, in order."""
        seq = list(pages)
        g["get"] = lambda url, pat, table=None: seq.pop(0)
        return read_table("Tasks")

    def check(name, ok):
        nonlocal checks
        checks += 1
        if not ok:
            failed.append(name)

    try:
        rows, n = run([{"records": [{"id": "rec1"}]}])
        check("a normal read returns its rows", len(rows) == 1 and n == 1)
        rows, n = run([{"records": []}])
        check("a genuinely empty page is zero rows, not an error", rows == [] and n == 1)
        rows, n = run([{"records": [{"id": "a"}], "offset": "o1"},
                       {"records": [{"id": "b"}]}])
        check("every page is followed", [r["id"] for r in rows] == ["a", "b"] and n == 2)
        # finding 20261104-phase-2-1187: a reply with no records key must NOT
        # read as zero. die() exits 2, so the guard shows up as SystemExit.
        for reply in ({"error": {"type": "UNKNOWN_FIELD_NAME"}}, {}, {"records": None},
                      {"records": {"id": "a"}}, []):
            try:
                run([reply])
                check("a reply with no records list is refused: %r" % (reply,), False)
            except SystemExit as e:
                check("a reply with no records list is refused: %r" % (reply,),
                      e.code == 2)
        # findings 20261102-ceo-huddle-1163 / 20261106-phase-2-1215: a lane
        # name resolves to a real table, and the caller is TOLD it did.
        check("a lane name resolves to its real table",
              resolve_table("Payment Run") == ("Dashboard Invoices", "Payment Run"))
        check("the alias match ignores case and spacing",
              resolve_table("  payment   RUN ") == ("Dashboard Invoices",
                                                    "  payment   RUN "))
        check("an ordinary table name is left exactly alone",
              resolve_table("Tasks") == ("Tasks", None))
        check("a name that IS the target is not reported as resolved",
              resolve_table("Dashboard Invoices") == ("Dashboard Invoices", None))
        # A 403/404 on a table read names the base's real tables instead of
        # leaving the caller to substitute a source of its own. Stubbed at
        # urlopen so the REAL get() error path runs, not a stand-in for it.
        class _Resp:
            def __init__(self, body):
                self._b = json.dumps(body).encode()

            def read(self):
                return self._b

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

        def urlopen_stub(code):
            def _open(req, timeout=None):
                url = req.full_url if hasattr(req, "full_url") else str(req)
                if "/meta/" in url:
                    return _Resp({"tables": [
                        {"id": "tbl1", "name": "Dashboard Invoices",
                         "fields": [{"name": "Invoice"}]},
                        {"id": "tbl2", "name": "Tasks",
                         "fields": [{"name": "Task Name"}]}]})
                raise urllib.error.HTTPError(url, code, "no", None, None)
            return _open

        saved_open = urllib.request.urlopen
        g["get"] = saved_get
        try:
            for code in (403, 404):
                urllib.request.urlopen = urlopen_stub(code)
                try:
                    read_table("Payment Run")
                    check("a %s on a table read is refused loudly" % code, False)
                except SystemExit as e:
                    check("a %s on a table read is refused loudly" % code,
                          e.code == 2)
            urllib.request.urlopen = urlopen_stub(403)
            hint = real_table_hint("Payment Run")
            check("the error names the base's real tables",
                  "Dashboard Invoices" in hint and "Tasks" in hint)
            check("the error forbids reading a different table instead",
                  "Never answer a refused read by reading a different table" in hint)
            check("the schema read is not itself re-explained (no recursion)",
                  _RESOLVING["on"] is False)
        finally:
            urllib.request.urlopen = saved_open
        # A count asks for one field, so a big table does not time out.
        g["get"] = lambda url, pat, table=None: (
            {"tables": [{"id": "tbl3", "name": "Transactions",
                         "fields": [{"name": "Name"}, {"name": "Amount"}]}]}
            if "/meta/" in url else {"records": []})
        check("a count reads the table's first field only",
              primary_field("Transactions") == "Name")
        saved_open = urllib.request.urlopen
        g["get"] = saved_get
        try:
            def _dead(req, timeout=None):
                url = req.full_url if hasattr(req, "full_url") else str(req)
                raise urllib.error.HTTPError(url, 500, "no", None, None)
            urllib.request.urlopen = _dead
            check("an unreadable schema gives no field rather than a guess",
                  primary_field("Transactions") is None)
        except SystemExit:
            check("an unreadable schema gives no field rather than a guess", False)
        finally:
            urllib.request.urlopen = saved_open
        check("a failed schema read leaves the recursion guard off",
              _RESOLVING["on"] is False)
    finally:
        g["get"], g["token"] = saved
    print(json.dumps({"checks": checks, "failed": failed}, indent=2))
    return 1 if failed else 0


def main(argv=None):
    if (argv if argv is not None else sys.argv[1:])[:1] == ["selftest"]:
        return selftest()
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
    table, asked_as = resolve_table(a.table)
    # A COUNT DOES NOT NEED THE ROWS. Transactions is 8,000+ rows, so 87 pages
    # of every field timed the Finance lane out at 120 s with nothing printed.
    # One field per row makes the same count cheap. If the schema cannot be
    # read we fall back to the full read and SAY so, rather than guess a field
    # name (an unknown field name is a 422, which would lose the count).
    light = False
    if a.count_only and not fields:
        pf = primary_field(table)
        if pf:
            fields, light = [pf], True
    rows, pages = read_table(table, formula=a.formula, fields=fields,
                             view=a.view, sort=a.sort, limit=a.limit,
                             by_field_id=a.by_field_id)
    out = {"ok": True, "table": table, "count": len(rows), "pages": pages}
    if asked_as:
        # NEVER a silent substitution (findings 1163, 1215): the output names
        # the table the rows came from AND the name that was asked for.
        out["resolvedFrom"] = asked_as
        out["note"] = ("%r is not a table in this base; it is the name for %r, "
                       "which is what was read." % (asked_as, table))
    if a.formula:
        out["formula"] = a.formula
    if a.count_only:
        out["lightCount"] = light
        if not light:
            out["lightCountNote"] = ("the table's field list could not be read, "
                                     "so every field was fetched; the count is "
                                     "right but the read was slow")
    else:
        out["records"] = rows
    print(json.dumps(out, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
