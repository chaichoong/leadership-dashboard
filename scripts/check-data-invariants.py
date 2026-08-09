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
import re
import sys
import urllib.parse
import urllib.request

BASE_ID = "appnqjDpqDniH3IRl"

# Overridable so the regression test can point the same code at a local stub server.
# Nothing else may set this — it defaults to the real API on every real run.
API_BASE = os.environ.get("AIRTABLE_API_BASE", "https://api.airtable.com").rstrip("/")
TX = "tbln0gzhCAorFc3zB"  # Transactions
BRIEFS = "tblIxbzDSOCI5hqJn"  # CEO Briefs
TASKS = "tblqB8b22hKBL4PF1"  # Tasks
PROJECTS = "tblHrpTMd5LNYn8v1"  # Projects (quarterly projects from the Strategy push)

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
    {
        # `Completion Date` is a dateTime and `Due Date` is a plain date, which
        # Airtable reads as midnight. So the original formula
        # (`{Completion Date} <= {Due Date}`) scored EVERY task finished on its
        # own due date as late — only work finished a full day early ever passed.
        # It reported Mica at 11% and Ericamae at 4% when the honest by-day
        # figures were 40% and 63%. A fixture test cannot see this: it is a
        # formula over real data shapes, so it has to be checked live.
        # Any comparison of a dateTime against a date needs this treatment.
        "name": "on-time-counts-the-due-date-itself",
        "table": TASKS,
        "incident": "Aug 2026 — 'Completed On Time' compared a dateTime to a date, marking 105 of Mica's and 137 of Ericamae's on-the-day completions late",
        "asserts": "completed ON the due date => Completed On Time = 1",
        "violation": (
            "AND({Is Complete} = 1, {Completion Date}, {Due Date}, "
            "IS_SAME({Completion Date}, {Due Date}, 'day'), "
            "{Completed On Time} != 1)"
        ),
        "control": ("AND({Is Complete} = 1, {Completion Date}, {Due Date}, "
                    "IS_SAME({Completion Date}, {Due Date}, 'day'))"),
        "control_means": "tasks finished on the exact day they were due (the only population this bug can corrupt)",
        # TRUE for every record and touches all three fields, so a renamed or
        # typo'd field still fails loudly rather than returning a quiet zero.
        "field_probe": ("OR({Completed On Time} >= 0, {Is Complete} >= 0, "
                        "LEN({Completion Date} & '') >= 0, LEN({Due Date} & '') >= 0)"),
        "fields": ["Task Name", "Due Date", "Completion Date", "Completed On Time"],
    },
    {
        # Airtable stamps "Not Started" on every project the Strategy push
        # creates, and for a year nothing ever cleared it. Both display copies
        # of the health rule then returned early on that value, so the quarter's
        # real position was never calculated. It is invisible by construction:
        # the dashboard looked calm, the projects looked new, and the only
        # symptom was a number that never moved.
        #
        # scripts/sync-project-status.mjs writes the derived status daily. This
        # is the control on that job — a job that stops running, or runs and
        # writes nothing, is indistinguishable from a healthy one otherwise.
        #
        # 7 days, not 0: inside the first 5% of a quarter "Not Started" is the
        # correct derived answer (see js/project-health.js), and 5% of a 91-day
        # quarter is ~4.5 days.
        "name": "started-projects-are-not-still-not-started",
        "table": PROJECTS,
        "incident": "Aug 2026 — 5 Q3 projects read 'Not Started' from 1 Jul to 3 Aug while sitting at 0 of 48 tasks and £0 of an £1,850 target",
        "asserts": "started more than 7 days ago AND not closed => status is no longer 'Not Started'",
        "violation": (
            "AND({Project Status} = 'Not Started', "
            "{Days from Start Date} > 7, "
            "LEN({Closed On} & '') = 0)"
        ),
        "control": "AND({Days from Start Date} > 7, LEN({Closed On} & '') = 0)",
        "control_means": "open projects whose start date has passed (the only population that can go stale)",
        # TRUE for every record and touches all three fields, so a renamed field
        # fails loudly instead of returning a quiet zero.
        "field_probe": ("OR(LEN({Project Status} & '') >= 0, {Days from Start Date} >= 0, "
                        "LEN({Closed On} & '') >= 0)"),
        "fields": ["Project Name", "Project Status", "Days from Start Date"],
    },
    {
        # An OPEN task carrying a Completion Date. Found 7 Aug 2026 by the
        # agent-dispatch routine; measured the same day at 143 open tasks, every
        # one of which also carries a Completed Month.
        #
        # It is not one bad bulk edit. The dates spread across late Apr and early
        # May 2026 and the statuses are mixed (56 Upcoming, 41 Today, 27
        # Approval, 16 blank, 3 Overdue), which is the shape of tasks that were
        # completed, had the date stamped by the "Change Status to Completed"
        # automation (see os/tasks/workflow.html), and were later REOPENED
        # without anything clearing the stamp. Reopening is the uncovered path.
        #
        # Why it matters beyond tidiness: `Completed Month` is what monthly
        # throughput is grouped by, so an open task counts toward a month it was
        # never finished in, and it inflates April/May for ever. A fixture test
        # cannot see this — it is the shape of real data, not of the code.
        #
        # NOTE ON FIRST RUN: this invariant fails immediately, because the 143
        # are still there. That is deliberate and correct — the alternative is
        # knowing about them and staying quiet. Clearing them is a bulk write on
        # Kevin's own data and is his call, not the sweep's.
        "name": "open-tasks-carry-no-completion-date",
        "table": TASKS,
        "incident": "Aug 2026 — 143 open tasks carried a Completion Date and Completed Month from Apr/May, inflating monthly throughput with work that was never finished",
        "asserts": "not completed => no Completion Date",
        "violation": "AND({Is Completed} = 0, {Completion Date})",
        # Every open task: the exact population a stale stamp can corrupt. If
        # this ever matches nothing the run FAILS rather than reading as clean.
        "control": "{Is Completed} = 0",
        "control_means": "open tasks (the only population that can carry a stale completion stamp)",
        # TRUE for every record and touches all three fields, so a rename or a
        # typo 422s loudly instead of returning a quiet zero. Note the base has
        # BOTH {Is Complete} and {Is Completed}; this uses {Is Completed}, which
        # is the one the 143 figure was measured against.
        #
        # Every term is LEN(x & '') >= 0, never a bare `{x} >= 0`. Measured here
        # 7 Aug 2026: `{Is Completed} >= 0` alone matches 6,864 of 7,023+ records,
        # i.e. it is FALSE for the ~159 whose value is blank — the CLAUDE.md trap
        # that blanked 8,667 transactions. Inside this OR the LEN terms happen to
        # rescue it, so the probe was not broken; it was one edit away from being
        # broken, and the day someone drops the other two terms it silently stops
        # covering blanks. Coercing to text is true for blank and populated alike.
        "field_probe": ("OR(LEN({Is Completed} & '') >= 0, LEN({Completion Date} & '') >= 0, "
                        "LEN({Completed Month (YYYY-MM)} & '') >= 0)"),
        "fields": ["Task Name", "Status", "Completion Date", "Completed Month (YYYY-MM)"],
    },
    {
        # A KPI marked automated carries a green "Auto" badge on the dashboard,
        # which reads as "this number maintains itself". When the compute code
        # cannot run, the badge stays and the value stays blank — the one state
        # that looks like "no data yet" rather than "broken".
        #
        # That is exactly what happened: the 6 May 2026 hardening banned the
        # backtick character outright, silently blocking five compute scripts,
        # one of them on a backtick inside a COMMENT. Two live KPIs never
        # produced a number between 6 May and 9 Aug and nothing said so.
        #
        # If a KPI claims to be automated and carries code, it must have run.
        "name": "automated-kpis-have-actually-run",
        "table": PROJECTS,
        "incident": "Aug 2026 — the compute denylist blocked 5 KPI scripts on a backtick; 2 live KPIs sat blank behind an 'Auto' badge for 3 months",
        # "Never ran" is not enough on its own. Written that way, this check
        # would NOT have caught the incident it was written for: had those two
        # KPIs computed even once before 6 May, the stamp would have sat there
        # for ever and the check would have been green through the entire
        # three-month outage. It has to catch "stopped running" too, so a KPI
        # whose stamp has not moved in 14 days counts as broken.
        #
        # The compute runs in the browser, so a fortnight of nobody opening the
        # dashboard also trips it. That is the correct answer, not noise: the
        # numbers really are that old.
        "asserts": "automated AND has compute code AND project open => KPI Last Updated is set AND fresher than 14 days",
        "violation": (
            "AND({KPI Automated} = 1, "
            "LEN({KPI Compute Code} & '') > 0, "
            "LEN({Closed On} & '') = 0, "
            "OR(LEN({KPI Last Updated} & '') = 0, "
            "IS_BEFORE({KPI Last Updated}, DATEADD(TODAY(), -14, 'days'))))"
        ),
        "control": ("AND({KPI Automated} = 1, LEN({KPI Compute Code} & '') > 0, "
                    "LEN({Closed On} & '') = 0)"),
        "control_means": "open projects with automated KPI compute code (the only population this can silently kill)",
        "field_probe": ("OR({KPI Automated} >= 0, LEN({KPI Compute Code} & '') >= 0, "
                        "LEN({KPI Last Updated} & '') >= 0)"),
        "fields": ["Project Name", "KPI Name", "KPI Automated", "KPI Last Updated"],
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
        url = f"{API_BASE}/v0/{BASE_ID}/{table}?{qs}"
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


KPI_LIBRARY_JS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "js", "kpi-library.js")


def _kpi_stems(text):
    """Significant-word stems (5-char prefixes) — mirrors the matcher in js/kpi-library.js."""
    return {w[:5] for w in re.split(r"[^a-z]+", str(text).lower()) if len(w) >= 5}


def _load_kpi_library_entries():
    """Parse the KPI_LIBRARY entries out of js/kpi-library.js.

    The page's data array is the CANONICAL library (docs/kpi-library-spec.md
    holds the rationale). A parse yielding suspiciously few entries means the
    file moved or the format changed — that is a broken check, so it raises
    rather than quietly asserting against an empty library.
    """
    try:
        with open(KPI_LIBRARY_JS, encoding="utf-8") as fh:
            src = fh.read()
        start = src.index("const KPI_LIBRARY = [")
        end = src.index("];", start)
    except (OSError, ValueError) as e:
        # Raise RuntimeError so the runner marks THIS check ERROR instead of
        # the whole sweep crashing (bit on 1 Aug 2026: a stale checkout without
        # js/kpi-library.js took down every other invariant with it).
        raise RuntimeError(f"cannot read the KPI library from {KPI_LIBRARY_JS}: {e}")
    block = src[start:end]
    entries = []
    for m in re.finditer(r"name: '((?:[^'\\]|\\.)*)'[\s\S]*?how: '((?:[^'\\]|\\.)*)'", block):
        entries.append((m.group(1).replace("\\'", "'"), m.group(2).replace("\\'", "'")))
    if len(entries) < 10:
        raise RuntimeError(
            f"parsed only {len(entries)} entries from {KPI_LIBRARY_JS} — the library data moved or "
            "changed format; fix this parser before trusting the check again"
        )
    return entries


def check_kpi_library_coverage(pat, library_entries=None):
    """Every live automated project KPI has a KPI Library counterpart.

    Added 2026-08-01, the day the library shipped. The library seeds client
    dashboards; a KPI that goes live on a project without a library template
    means the library has silently fallen behind Kevin's own build — exactly
    the drift the standing "write every KPI generically" rule exists to
    prevent. The page's health bar runs this same test, but only when the tab
    is opened; this is the scheduled version that fires without a browser.

    Matching is stem overlap on significant words (5-char prefixes), the same
    matcher the page uses, so word order and -ed/-ing endings don't false-flag.

    Returns (violations, control_population). Control = open projects carrying
    KPI compute code; Kevin always has at least one, so zero means the query
    or field names broke, not that measurement stopped.
    """
    entries = library_entries if library_entries is not None else _load_kpi_library_entries()
    entry_stems = [(name, _kpi_stems(name + " " + how)) for name, how in entries]
    formula = (
        'AND(LEN({KPI Name} & "") > 0, {Closed On} = BLANK(), '
        'LEN({KPI Compute Code} & "") > 0)'
    )
    live = query(pat, PROJECTS, formula, ["Project Name", "KPI Name"])
    violations = []
    for r in live:
        kpi = str(r["fields"].get("KPI Name") or "")
        ks = _kpi_stems(kpi)
        if not any(ks & stems for _, stems in entry_stems):
            violations.append({
                "project": r["fields"].get("Project Name"),
                "kpi": kpi,
                "fix": "add the template to KPI_LIBRARY in js/kpi-library.js (and the rationale to docs/kpi-library-spec.md) in the same change that added the KPI",
                "id": r["id"],
            })
    return violations, len(live)


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
        "name": "kpi-library-coverage",
        "asserts": "live automated project KPI => a KPI Library template exists for it",
        "incident": "Aug 2026 — the library seeds client dashboards; a live KPI with no template means the library fell behind the build",
        "control_means": "open projects carrying KPI compute code (the population the library must cover)",
        "run": check_kpi_library_coverage,
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


def query(pat, table, formula, fields=None, page_size=100, limit=None):
    """Return ALL records matching formula, following Airtable's offset token.

    Raises on API error rather than reporting a false pass — an auth failure must
    never look like 'zero violations'.

    The pagination is the point. Until 9 Aug 2026 this function read one page and
    stopped, so any violation population larger than a page was reported at exactly
    the page size. On 9 Aug the open-tasks-carry-no-completion-date invariant printed
    "100 VIOLATION(S)" when the truth was 143 — a round number that reads as a real
    count and never errors. This is the same anti-pattern that made the AI
    Reconciliation Accuracy card report 66/100 against a 259-row window, and it was
    living inside the script written to catch that class of bug.

    `limit` stops early for existence-only reads (the field probe wants one row, not
    the whole table). It caps the result; it never causes a silent under-count,
    because every caller that reports a NUMBER leaves it unset.
    """
    records = []
    offset = None
    while True:
        params = {"filterByFormula": formula, "pageSize": str(page_size)}
        qs = urllib.parse.urlencode(params)
        for f in fields or []:
            qs += "&" + urllib.parse.urlencode({"fields[]": f})
        if offset:
            qs += "&" + urllib.parse.urlencode({"offset": offset})
        url = f"{API_BASE}/v0/{BASE_ID}/{table}?{qs}"
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
        records += body.get("records", [])
        offset = body.get("offset")
        if not offset or (limit is not None and len(records) >= limit):
            return records[:limit] if limit is not None else records


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
            # Existence check, not a count — `limit` keeps it to one page. The
            # report says "N+ live records" for exactly this reason.
            control = query(pat, inv["table"], inv["control"], page_size=100, limit=100)
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
                        probe_ok = bool(query(pat, inv["table"], inv["field_probe"],
                                              page_size=1, limit=1))
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
