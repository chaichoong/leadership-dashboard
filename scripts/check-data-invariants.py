#!/usr/bin/env python3
"""Live Airtable data invariants — the regression net the fixture suite cannot cast.

WHY THIS EXISTS, SEPARATE FROM tests/sync-invariants/
----------------------------------------------------
tests/sync-invariants/ mocks the Airtable API (page.route intercepts /v0/**) so the
pre-push gate stays deterministic and offline. That is correct for catching JS
regressions, but it means those tests stub out the exact layer that has caused this
platform's two worst incidents. A formula bug lives INSIDE Airtable; a test that
fakes Airtable's response can never see it.

Both incidents below shipped green through a full fixture suite. They are only
visible by asking the real base what it computes.

INVARIANTS
----------
1. report-amount-populated
   Jul 2026: `Report Amount`'s guard was changed from `ABS({override}) > 0` to
   `{override} != 0` to allow negative overrides. In Airtable a blank number is NOT
   equal to 0, so `{blank} != 0` is TRUE — every record without an override took the
   override branch and returned blank. 8,667 of 8,690 transactions blanked, taking
   out P&L, dashboard, Wealth and cashflow at once.
   Invariant: if **GBP has a value, Report Amount must have one too.

2. split-override-sign
   The split modal collects positive magnitudes (Math.abs; validation requires each
   portion > 0), and `Report Amount` returns the override verbatim. Writing a positive
   override on an expense flips an outflow into revenue across every report. Inflow
   splits hid this for years because their sign is already positive; the first expense
   split would have posted £1,742.60 of costs as income.
   Invariant: where an override is set, sign(Report Amount) == sign(**GBP).

Adding one: append to INVARIANTS. Each needs a real incident behind it, a
filterByFormula that returns ONLY violations, and a `control` formula proving the
filter can fire (a population the bug would corrupt). A check whose control returns 0
is asserting nothing and fails the run — that is deliberate, and it is what stops this
file quietly rotting into 'all green, testing nothing'.

Airtable formula gotchas, learned the hard way:
  - No SIGN(). Compare signs explicitly with AND/OR.
  - Blank != 0 is TRUE. Use ABS({field}) > 0 to mean "set and non-zero".

Usage:  python3 scripts/check-data-invariants.py [--json]
Exit:   0 = all invariants hold, 1 = violation or control failure.
Auth:   ~/.config/od/airtable_pat (never printed).
"""

import json
import os
import sys
import urllib.parse
import urllib.request

BASE_ID = "appnqjDpqDniH3IRl"
TX = "tbln0gzhCAorFc3zB"  # Transactions

INVARIANTS = [
    {
        "name": "report-amount-populated",
        "table": TX,
        "incident": "Jul 2026 — blanked Report Amount on 8,667/8,690 txns; P&L, dashboard, Wealth, cashflow all down",
        "asserts": "**GBP set => Report Amount set",
        "violation": "AND(ABS({**GBP}) > 0, {Report Amount} = BLANK())",
        "control": "ABS({**GBP}) > 0",
        "control_means": "transactions with a GBP value (the population the bug blanked)",
        "fields": ["Report Amount", "**GBP"],
    },
    {
        "name": "split-override-sign",
        "table": TX,
        "incident": "Jul 2026 — a positive override on an expense split posts costs as income (£1,742.60 caught pre-write)",
        "asserts": "override set => sign(Report Amount) == sign(**GBP)",
        "violation": (
            "AND(ABS({Split Override Amount}) > 0, "
            "OR(AND({Report Amount} > 0, {**GBP} < 0), "
            "AND({Report Amount} < 0, {**GBP} > 0)))"
        ),
        "control": "AND(ABS({Split Override Amount}) > 0, {Split Override Amount} < 0)",
        "control_means": "negatively-signed overrides (expense splits — the ones the bug flips)",
        "fields": ["Report Amount", "**GBP", "Split Override Amount"],
    },
]


def scan_all(pat, table, fields):
    """Every record in a table, paginated. For invariants that compare records to each
    other — filterByFormula can only test one record at a time."""
    records = []
    offset = None
    while True:
        qs = urllib.parse.urlencode({"pageSize": "100"})
        for f in fields:
            qs += "&" + urllib.parse.urlencode({"fields[]": f})
        if offset:
            qs += "&" + urllib.parse.urlencode({"offset": offset})
        url = f"https://api.airtable.com/v0/{BASE_ID}/{table}?{qs}"
        req = urllib.request.Request(url, headers={"Authorization": f"Bearer {pat}"})
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                body = json.load(resp)
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")[:200]
            raise RuntimeError(f"HTTP {e.code}: {detail}") from None
        except Exception as e:
            raise RuntimeError(f"request failed: {e}") from None
        if "error" in body:
            raise RuntimeError(f"Airtable error: {body['error']}")
        records += body.get("records", [])
        offset = body.get("offset")
        if not offset:
            return records


def check_reimport_duplicates(pat):
    """Same bank transaction imported twice under two different Plaid account ids.

    Found 2026-07-21: three Santander accounts were re-linked, so the feed re-imported
    their history under a NEW Plaid account id. 64 duplicate transactions, £2,316 of
    double-counted money, sitting in the Wealth and P&L figures unnoticed for months.

    The Plaid transaction id is "<plaidAccountId>--<transactionHash>". The hash is
    stable for a given bank transaction, so the SAME hash appearing under two different
    account ids means one real payment was imported twice. Matching on date+amount
    instead would flag genuine same-day same-value pairs (two £56.99 Amazon charges on
    20 Mar 2026 were real, not duplicates) — the hash does not have that problem.

    Returns (violations, control_population).
    """
    records = scan_all(pat, TX, ["**Plaid TX ID", "Account Alias (from **Account)", "**GBP", "**Date"])
    by_hash = {}
    control = 0
    for r in records:
        pid = str(r["fields"].get("**Plaid TX ID") or "")
        if "--" not in pid:
            continue
        control += 1
        account_id, tx_hash = pid.split("--", 1)
        by_hash.setdefault(tx_hash, {}).setdefault(account_id, []).append(r)

    violations = []
    for tx_hash, by_account in by_hash.items():
        if len(by_account) < 2:
            continue
        copies = [r for group in by_account.values() for r in group]
        alias = copies[0]["fields"].get("Account Alias (from **Account)")
        alias = (alias[0] if isinstance(alias, list) and alias else alias) or "(unknown account)"
        violations.append({
            "account": alias,
            "date": copies[0]["fields"].get("**Date"),
            "amount": copies[0]["fields"].get("**GBP"),
            "copies": len(copies),
            "plaid_account_ids": sorted(by_account.keys()),
            "ids": [r["id"] for r in copies],
        })
    return violations, control


SCANS = [
    {
        "name": "no-reimport-duplicates",
        "asserts": "one bank transaction => one record (not re-imported under a second Plaid account id)",
        "incident": "Jul 2026 — Santander accounts re-linked; 64 duplicates, £2,316 double-counted across Wealth and P&L",
        "control_means": "transactions carrying a Plaid id (the population a re-import duplicates)",
        "run": check_reimport_duplicates,
    },
]


def load_pat():
    path = os.path.expanduser("~/.config/od/airtable_pat")
    try:
        with open(path) as fh:
            pat = fh.read().strip()
    except OSError:
        sys.stderr.write(f"FATAL: cannot read Airtable PAT at {path}\n")
        sys.exit(2)
    if not pat:
        sys.stderr.write(f"FATAL: Airtable PAT at {path} is empty\n")
        sys.exit(2)
    return pat


def query(pat, table, formula, fields=None, page_size=100):
    """Return records matching formula. Raises on API error rather than reporting a
    false pass — an auth failure must never look like 'zero violations'."""
    params = {"filterByFormula": formula, "pageSize": str(page_size)}
    qs = urllib.parse.urlencode(params)
    for f in fields or []:
        qs += "&" + urllib.parse.urlencode({"fields[]": f})
    url = f"https://api.airtable.com/v0/{BASE_ID}/{table}?{qs}"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {pat}"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = json.load(resp)
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:200]
        raise RuntimeError(f"HTTP {e.code}: {detail}") from None
    except Exception as e:
        raise RuntimeError(f"request failed: {e}") from None
    if "error" in body:
        raise RuntimeError(f"Airtable error: {body['error']}")
    return body.get("records", [])


def main():
    as_json = "--json" in sys.argv
    pat = load_pat()
    results = []
    failed = False

    for inv in INVARIANTS:
        entry = {"name": inv["name"], "asserts": inv["asserts"]}
        try:
            # Control first: prove the filter can actually fire. Without this, a typo'd
            # field name returns zero rows and reads as a pass forever.
            control = query(pat, inv["table"], inv["control"], page_size=100)
            if not control:
                entry.update(
                    status="CONTROL_FAILED",
                    detail=f"control matched 0 records ({inv['control_means']}) — this check is asserting nothing",
                )
                failed = True
                results.append(entry)
                continue

            violations = query(pat, inv["table"], inv["violation"], inv["fields"])
            if violations:
                entry.update(
                    status="FAIL",
                    count=len(violations),
                    incident=inv["incident"],
                    samples=[{"id": r["id"], **r["fields"]} for r in violations[:5]],
                )
                failed = True
            else:
                entry.update(status="PASS", control_population=len(control))
        except RuntimeError as e:
            entry.update(status="ERROR", detail=str(e))
            failed = True
        results.append(entry)

    # Cross-record invariants. Same control discipline as the formula ones: if the
    # scan sees no eligible population, that is a BROKEN check, not a pass.
    for scan in SCANS:
        entry = {"name": scan["name"], "asserts": scan["asserts"]}
        try:
            violations, control = scan["run"](pat)
            if not control:
                entry.update(
                    status="CONTROL_FAILED",
                    detail=f"control matched 0 records ({scan['control_means']}) — this check is asserting nothing",
                )
                failed = True
            elif violations:
                entry.update(
                    status="FAIL",
                    count=len(violations),
                    incident=scan["incident"],
                    samples=violations[:5],
                )
                failed = True
            else:
                entry.update(status="PASS", control_population=control)
        except RuntimeError as e:
            entry.update(status="ERROR", detail=str(e))
            failed = True
        results.append(entry)

    if as_json:
        print(json.dumps({"ok": not failed, "invariants": results}, indent=2))
    else:
        print("Live Airtable data invariants")
        print("=" * 60)
        for r in results:
            mark = {"PASS": "PASS  ", "FAIL": "FAIL  ", "ERROR": "ERROR ", "CONTROL_FAILED": "BROKEN"}[r["status"]]
            print(f"{mark} {r['name']}")
            print(f"       asserts: {r['asserts']}")
            if r["status"] == "PASS":
                print(f"       checked against {r['control_population']}+ live records — no violations")
            elif r["status"] == "FAIL":
                print(f"       {r['count']} VIOLATION(S)")
                print(f"       regression of: {r['incident']}")
                for s in r["samples"]:
                    print(f"         {s}")
            else:
                print(f"       {r['detail']}")
            print()
        print("=" * 60)
        print("RESULT:", "all invariants hold" if not failed else "INVARIANT BROKEN — do not deploy")

    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
