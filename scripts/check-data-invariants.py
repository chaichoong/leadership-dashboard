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

A guard on a BRAND-NEW feature has a real problem here: its population is legitimately
zero until the feature sees traffic, and a check that reports BROKEN every day is a
check nobody reads. For those, add `field_probe`: a formula that is TRUE for every
record AND names the same fields. Airtable rejects a formula with a bad field name
outright, so the probe still catches a typo; an empty control WITH a passing probe
reports WAITING instead of BROKEN, and starts asserting the moment real records exist.
Do not add `field_probe` to an invariant whose population should already be non-empty —
there, an empty control is the bug.

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
BRIEFS = "tblIxbzDSOCI5hqJn"  # CEO Briefs
TASKS = "tblqB8b22hKBL4PF1"  # Tasks

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
    {
        # The browser guard (approvalGateBlocks) and the Slack worker both refuse
        # this move, but neither can stop a write made straight to the Airtable
        # API — by an automation, a script, or an agent. A completed piece of
        # agent work with no recorded verdict means something shipped without
        # Kevin seeing it, which is the whole failure the gate exists to prevent.
        "name": "agent-work-completed-without-approval",
        "table": TASKS,
        "incident": "Jul 2026 — 157 of 315 open tasks moved to AI agents with no approval mechanism at all",
        "asserts": "agent-worked AND completed => an approval outcome is recorded",
        "violation": (
            "AND({Processed by AI Agent} = 1, {Status} = 'Completed', "
            "LEN({Approval Outcome} & '') = 0, "
            "LEN(ARRAYJOIN({Sent For Approval By}) & '') > 0)"
        ),
        "control": "LEN(ARRAYJOIN({Sent For Approval By}) & '') > 0",
        "control_means": "tasks an agent has ever raised for approval (the population this can corrupt)",
        # TRUE for every record, and it touches all three field names, so a typo
        # is still caught while the loop is waiting for its first real task.
        "field_probe": ("OR(LEN({Approval Outcome} & '') >= 0, {Processed by AI Agent} = 1, "
                        "LEN(ARRAYJOIN({Sent For Approval By}) & '') >= 0)"),
        "fields": ["Task Name", "Status", "Approval Outcome", "Processed by AI Agent"],
    },
    {
        # An approval that cannot be handed back to anyone dead-ends: Kevin says
        # yes and nothing carries the action out. Cheap to catch, invisible
        # otherwise, because the task simply sits there looking fine.
        "name": "waiting-approval-has-an-agent",
        "table": TASKS,
        "incident": "Jul 2026 — approval returns work to 'Sent For Approval By'; with that empty there is nobody to return it to",
        "asserts": "Status = Approval AND agent-worked => an agent is recorded",
        "violation": (
            "AND({Status} = 'Approval', {Processed by AI Agent} = 1, "
            "LEN(ARRAYJOIN({Sent For Approval By}) & '') = 0, "
            "LEN(ARRAYJOIN({Team Member}) & '') = 0)"
        ),
        "control": "{Status} = 'Approval'",
        "control_means": "tasks currently waiting for Kevin's approval",
        "field_probe": ("OR({Status} = 'Approval', {Processed by AI Agent} = 1, "
                        "LEN(ARRAYJOIN({Team Member}) & '') >= 0)"),
        "fields": ["Task Name", "Status", "Processed by AI Agent"],
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


def check_ceo_brief_complete(pat):
    """Every past weekday CEO brief is finished, and each date appears exactly once.

    Found 2026-07-31. Two bugs hid behind the same shape. `gatherHuddle` in the worker read
    an Airtable response by field ID without asking for field IDs, so it silently returned
    "no huddle today" on EVERY run: the 07:30 department huddle's conclusion was binned, and
    the missing record id sent storeBrief down its POST branch, writing a duplicate row for
    the day instead of filling in the 07:30 stub. Separately the brief blew past max_tokens
    and the JSON never closed, so `Full Brief` stayed empty and Kevin got a money-only DM.

    Neither bug raised anything. "No huddle ran" is also what a genuinely quiet day looks
    like, and an empty `Full Brief` on today's row is normal until 09:00. A failure shaped
    exactly like a normal morning is why this needs a live check rather than a fixture.

    Only dates STRICTLY BEFORE today are asserted on, so a run before 09:00 is not a false
    red. Weekends are skipped: the cron is Mon-Fri.

    Returns (violations, control_population).
    """
    import datetime

    rows = query(pat, BRIEFS, "IS_AFTER({Date}, DATEADD(TODAY(), -21, 'days'))",
                 fields=["Date", "One Thing", "Full Brief"], page_size=100)
    today = datetime.datetime.now(datetime.timezone.utc).date().isoformat()

    by_date = {}
    control = 0
    for r in rows:
        date = str(r["fields"].get("Date") or "")
        if not date:
            continue
        # A weekday in the past is the only population either bug could corrupt.
        if date >= today or datetime.date.fromisoformat(date).weekday() >= 5:
            continue
        control += 1
        by_date.setdefault(date, []).append(r)

    violations = []
    for date, recs in sorted(by_date.items()):
        if len(recs) > 1:
            violations.append({
                "date": date,
                "problem": f"{len(recs)} rows for one date — the 09:00 store POSTed instead of PATCHing the 07:30 stub",
                "ids": [r["id"] for r in recs],
            })
        for r in recs:
            if not r["fields"].get("Full Brief"):
                violations.append({
                    "date": date,
                    "problem": "Full Brief empty on a past weekday — the 09:00 brief never landed",
                    "ids": [r["id"]],
                })
    return violations, control


SCANS = [
    {
        "name": "ceo-brief-complete",
        "asserts": "past weekday => exactly one CEO Briefs row, and its Full Brief is populated",
        "incident": "Jul 2026 — huddle silently binned for 2 days + duplicate rows + a truncated brief; Kevin got a money-only DM",
        "control_means": "CEO Briefs rows on past weekdays (the population both bugs corrupt)",
        "run": check_ceo_brief_complete,
    },
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
                # An empty control is normally a typo'd field name, which would
                # read as a pass forever — so it fails hard. But a brand-new
                # feature legitimately has no traffic yet, and a check that goes
                # red every day for that is a check nobody reads.
                #
                # `field_probe` tells the two apart. It is a formula that is TRUE
                # for every record AND references the same fields. If the field
                # names are wrong Airtable rejects the formula outright; if they
                # are right it returns rows even when the real population is
                # zero. Probe passes + control empty = SKIP, not BROKEN.
                probe_ok = False
                probe_err = ""
                if inv.get("field_probe"):
                    try:
                        probe_ok = bool(query(pat, inv["table"], inv["field_probe"], page_size=1))
                    except RuntimeError as e:
                        probe_err = str(e)
                if probe_ok:
                    entry.update(
                        status="SKIP",
                        detail=f"no records yet in the population this guards ({inv['control_means']}); "
                               f"field names verified live, so this starts asserting the moment there are",
                    )
                else:
                    entry.update(
                        status="CONTROL_FAILED",
                        detail=f"control matched 0 records ({inv['control_means']}) — this check is asserting nothing"
                               + (f"; field probe also failed: {probe_err}" if probe_err else ""),
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
            mark = {"PASS": "PASS  ", "FAIL": "FAIL  ", "ERROR": "ERROR ",
                    "CONTROL_FAILED": "BROKEN", "SKIP": "WAITING"}[r["status"]]
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
        waiting = sum(1 for r in results if r["status"] == "SKIP")
        summary = "all invariants hold" if not failed else "INVARIANT BROKEN — do not deploy"
        if waiting and not failed:
            summary += f" ({waiting} waiting for their first live record)"
        print("RESULT:", summary)

    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
