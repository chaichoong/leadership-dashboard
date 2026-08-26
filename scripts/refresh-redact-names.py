#!/usr/bin/env python3
"""Rebuild the name roster that report_scrub.py masks out of public reports.

WHY THIS EXISTS (24 Aug 2026 - finding 20260821-task-hygiene-sweep-286)
-----------------------------------------------------------------------
github.com/chaichoong/leadership-dashboard is PUBLIC. Four tracked task-sweep
reports named an individual tenant against a rent-arrears task, and one named a
family member against a 2023/24 tax liability. The working tree was redacted by
hand on 21 Aug. Hand-redaction is not a control: it lasts as long as somebody
is watching a 07:00 unattended job.

report_scrub.py now masks any name on a roster. This script keeps that roster
current, so a tenant added to Airtable today is covered by tomorrow's report
rather than whenever somebody remembers.

WHERE THE ROSTER LIVES
----------------------
~/.config/od/redact-names.txt - OUTSIDE the repo, deliberately. A checked-in
list of the people we must not name would leak exactly the names it protects.

MANUAL ENTRIES SURVIVE
----------------------
Only the block between the GENERATED markers is rewritten. Anything you add
above or below it (a family member, a counterparty, anyone who is not an
Airtable tenant) is preserved verbatim on every refresh.

EVERY QUERY DECLARES WHAT IT EXPECTS
------------------------------------
A wrong table id or field name returns 200 OK and an empty list, and an empty
roster reads as "nobody to mask" for ever. So a run that reads FEWER than
--min-tenants names fails and leaves the existing roster untouched.
"""

import argparse
import json
import os
import sys
import urllib.error
import urllib.request

BASE = "appnqjDpqDniH3IRl"
TENANTS_TABLE = "tblX4elTuu01gwBYh"  # js/config.js TABLES.tenants
NAME_FIELD = "Tenant Name"
SURNAME_FIELD = "Tenant Surname"

PAT_FILE = os.path.expanduser("~/.config/od/airtable_pat")
DEFAULT_ROSTER = os.path.expanduser("~/.config/od/redact-names.txt")

BEGIN = "# --- GENERATED from Airtable Tenants: do not edit below this line ---"
END = "# --- END GENERATED ---"

HEADER = """# Names masked out of monitoring/ reports before they enter the PUBLIC repo.
# One full name per line. Single words are ignored (too collision-prone).
# Read by scripts/report_scrub.py; rebuilt by scripts/refresh-redact-names.py.
#
# Add manual entries ABOVE the generated block. They survive every refresh.
"""


def pat():
    with open(PAT_FILE) as fh:
        return fh.read().strip()


def fetch_tenants(token):
    """All tenant names. Paginates: a hand-rolled read that stops at 100 is how
    the recon accuracy card measured 100 rows and called it 259."""
    names, offset = [], None
    while True:
        url = "https://api.airtable.com/v0/%s/%s?pageSize=100" % (BASE, TENANTS_TABLE)
        if offset:
            url += "&offset=" + offset
        req = urllib.request.Request(url, headers={"Authorization": "Bearer " + token})
        with urllib.request.urlopen(req, timeout=30) as resp:
            payload = json.load(resp)
        for rec in payload.get("records", []):
            fields = rec.get("fields", {})
            full = (fields.get(NAME_FIELD) or "").strip()
            surname = (fields.get(SURNAME_FIELD) or "").strip()
            if full and len(full.split()) >= 2:
                names.append(full)
            elif full and surname:
                names.append("%s %s" % (full, surname))
        offset = payload.get("offset")
        if not offset:
            break
    return sorted(set(names))


def split_existing(path):
    """Return (manual_lines, had_generated_block)."""
    if not os.path.isfile(path):
        return [], False
    manual, inside, had = [], False, False
    with open(path, encoding="utf-8") as fh:
        for line in fh.read().splitlines():
            if line.strip() == BEGIN:
                inside, had = True, True
                continue
            if line.strip() == END:
                inside = False
                continue
            if not inside and not line.startswith("#"):
                manual.append(line)
    return [m for m in manual if m.strip()], had


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--roster", default=os.environ.get("OD_REDACT_NAMES", DEFAULT_ROSTER))
    ap.add_argument("--min-tenants", type=int, default=10,
                    help="fail rather than write a suspiciously small roster")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    try:
        names = fetch_tenants(pat())
    except (OSError, urllib.error.URLError, ValueError) as exc:
        print("ERROR: could not read Tenants: %s" % exc, file=sys.stderr)
        print("Roster left unchanged at %s" % args.roster, file=sys.stderr)
        return 1

    if len(names) < args.min_tenants:
        print("ERROR: read only %d tenant names, expected at least %d. A wrong "
              "table id or field name returns 200 OK and an empty list, so this "
              "is treated as a broken query, not an empty portfolio. Roster left "
              "unchanged." % (len(names), args.min_tenants), file=sys.stderr)
        return 1

    manual, _ = split_existing(args.roster)
    body = [HEADER.rstrip(), ""]
    if manual:
        body.extend(manual)
        body.append("")
    body.append(BEGIN)
    body.extend(names)
    body.append(END)
    text = "\n".join(body) + "\n"

    if args.dry_run:
        print("would write %d generated + %d manual name(s) to %s"
              % (len(names), len(manual), args.roster))
        return 0

    os.makedirs(os.path.dirname(args.roster), exist_ok=True)
    with open(args.roster, "w", encoding="utf-8") as fh:
        fh.write(text)
    os.chmod(args.roster, 0o600)
    # The COUNT is printed, never the names: this output lands in the daily-ops
    # report, which is committed to the public repo.
    print("roster updated: %d generated + %d manual name(s) -> %s"
          % (len(names), len(manual), args.roster))
    return 0


if __name__ == "__main__":
    sys.exit(main())
