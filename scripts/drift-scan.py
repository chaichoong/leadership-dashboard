#!/usr/bin/env python3
"""Airtable schema drift and dead-reference scan — a diff, not a judgement.

WHY THIS IS A SCRIPT (26 Aug 2026, Kevin's restructure)
------------------------------------------------------
The drift monitor ran as a Claude phase inside daily-ops and was the single
largest source of findings: 68 open on 26 Aug, more than any other routine, on
a queue of 202 that nothing could drain. Its own reports said what most of that
was worth. On 23 Aug: the SOP version metric is "red every day and carries no
signal". The schema had not changed at all between 16 and 24 Aug. Its browser
health checks were skipped every single day, because nothing runs a browser in
an unattended session.

What is left once the noise goes is CHECK 1 and CHECK 2, and neither needs
judgement. Fetch the schema, diff it against yesterday, resolve every Airtable
ID in the repo against it. That is arithmetic. It runs in seconds as a wrapped
job, and Claude only reads the result when this exits non-zero.

THE CONTROLS
------------
A scan that finds nothing is indistinguishable from a scan that is broken, and
this codebase has been burned by exactly that twice: a UC query that matched 0
of 91 records for four months, and an accuracy card that read the first 100 of
259 rows. So three states FAIL as "cannot verify" rather than passing clean:

  1. The schema comes back with fewer than MIN_TABLES tables. A revoked PAT, a
     wrong base ID or a changed endpoint all return something plausible-looking.
  2. The reference map is empty or unreadable. Resolving nothing against
     anything passes for ever.
  3. The whole-repo scan finds fewer than MIN_REPO_IDS Airtable IDs. A typo in
     the regex returns zero matches and reads as "no rogue references, all
     clean" — the exact silent-zero trap in CLAUDE.md.

Exit 0  nothing changed, nothing dead
Exit 1  drift found; the exceptions file names it
Exit 2  cannot verify — treat as broken, never as clean
"""

import argparse
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import datetime

BASE_ID = os.environ.get("AIRTABLE_BASE_ID", "appnqjDpqDniH3IRl")
PAT_FILE = os.environ.get("AIRTABLE_PAT_FILE",
                          os.path.expanduser("~/.config/od/airtable_pat"))
REPO = os.environ.get("OD_REPO", os.path.dirname(
    os.path.dirname(os.path.abspath(__file__))))

# Control floors. Deliberately far below the real numbers (121 tables, 422
# mapped fields, ~340 repo IDs on 26 Aug 2026) so ordinary growth or pruning
# never trips them, and a broken read always does.
MIN_TABLES = 50
MIN_REPO_IDS = 100

SCAN_EXTS = (".js", ".mjs", ".html", ".py")
# `tests` is excluded deliberately, and this is the one judgement call in the
# file. Test fixtures INVENT Airtable-shaped ids on purpose — this script's own
# own test builds zero-padded `tbl` ids on purpose — so scanning them reports a
# permanent false DRIFT every single day, and an exceptions file that is never
# empty is one nobody reads. Known limit, stated rather than hidden: a test
# referencing a genuinely dead PRODUCTION id is not caught here. config.js
# remains covered by the reference-map check, which is where real references
# live.
SKIP_DIRS = {"node_modules", ".git", "monitoring", "test-results",
             "playwright-report", ".claude", "dist", "coverage", "tests"}

# An identifier boundary on BOTH sides. Without it the scan matches inside
# ordinary variable names; with it, names like `selectedProjectId` and
# `reconciledInflows` still match, so every candidate is RESOLVED against the
# schema rather than filtered by name. A false positive and a genuinely dead ID
# then land in the same place and neither is silently dropped.
ID_RE = re.compile(r"(?<![A-Za-z0-9_])(fld|tbl|rec|sel)[A-Za-z0-9]{14}(?![A-Za-z0-9_])")


def fail(reason, detail=""):
    return 2, {"ok": False, "verdict": "CANNOT VERIFY",
               "reason": reason, "detail": detail}


def fetch_schema():
    """The whole base schema, paginated. Never prints the token."""
    try:
        with open(PAT_FILE) as f:
            pat = f.read().strip()
    except OSError as e:
        return None, "cannot read the Airtable token file: %s" % e.strerror
    if not pat:
        return None, "the Airtable token file is empty"

    tables, offset = [], None
    while True:
        url = "https://api.airtable.com/v0/meta/bases/%s/tables" % BASE_ID
        if offset:
            url += "?offset=%s" % offset
        req = urllib.request.Request(url, headers={"Authorization": "Bearer %s" % pat})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                page = json.load(r)
        except urllib.error.HTTPError as e:
            # The status, never the token or the header.
            return None, "Airtable meta API returned HTTP %s" % e.code
        except Exception as e:                       # noqa: BLE001
            return None, "Airtable meta API unreachable: %s" % type(e).__name__
        tables.extend(page.get("tables", []))
        offset = page.get("offset")
        if not offset:
            break

    compact = {}
    for t in tables:
        compact[t["id"]] = {
            "name": t.get("name"),
            "fields": {f["id"]: {"name": f.get("name"), "type": f.get("type")}
                       for f in t.get("fields", [])},
        }
    return compact, None


def diff_schema(today, prior):
    """What changed between two snapshots. Renames and retypes, not just adds."""
    d = {"new_tables": [], "removed_tables": [], "new_fields": [],
         "removed_fields": [], "renamed_fields": [], "retyped_fields": []}
    for tid, t in today.items():
        if tid not in prior:
            d["new_tables"].append("%s (%s)" % (t["name"], tid))
            continue
        p = prior[tid]
        for fid, f in t["fields"].items():
            pf = p.get("fields", {}).get(fid)
            if pf is None:
                d["new_fields"].append("%s.%s (%s)" % (t["name"], f["name"], fid))
            else:
                if pf.get("name") != f.get("name"):
                    d["renamed_fields"].append(
                        "%s: %s -> %s (%s)" % (t["name"], pf.get("name"), f["name"], fid))
                if pf.get("type") != f.get("type"):
                    d["retyped_fields"].append(
                        "%s.%s: %s -> %s" % (t["name"], f["name"], pf.get("type"), f.get("type")))
        for fid, pf in p.get("fields", {}).items():
            if fid not in t["fields"]:
                d["removed_fields"].append("%s.%s (%s)" % (t["name"], pf.get("name"), fid))
    for tid, p in prior.items():
        if tid not in today:
            d["removed_tables"].append("%s (%s)" % (p.get("name"), tid))
    return d


def known_ids(schema):
    ids = set(schema)
    for t in schema.values():
        ids.update(t["fields"])
    return ids


def tracked_files():
    """Git's file list, or None if git cannot answer.

    TRACKED FILES ONLY, and that is deliberate. The repo root collects
    untracked scratch (`_tmp_costs_query.py` and a dozen siblings on 26 Aug
    2026) carrying ids from other bases and older experiments. One held a table
    id that returns HTTP 403 rather than 404 — this token cannot SEE it, which
    is not evidence that it is dead, and it would have been reported as
    unresolvable every day for ever. Scratch nobody committed is not the
    codebase.

    (Note the literal ids are described, never written out: this file is itself
    scanned, and an example id in a comment reports as a dead reference.)

    The cost is a one-day lag on a genuinely new file. The daily scan picks it
    up the moment it is committed, which is also the moment it starts mattering.
    """
    try:
        out = subprocess.run(["git", "-C", REPO, "ls-files", "-z"],
                             capture_output=True, timeout=30)
    except (OSError, subprocess.SubprocessError):
        return None
    if out.returncode != 0:
        return None
    names = [n for n in out.stdout.decode("utf-8", "ignore").split("\0") if n]
    return names or None


def scan_repo():
    """Every Airtable-shaped ID in the repo's tracked files."""
    found = {}
    tracked = tracked_files()
    if tracked is not None:
        for rel in tracked:
            if not rel.endswith(SCAN_EXTS):
                continue
            if any(part in SKIP_DIRS for part in rel.split(os.sep)):
                continue
            path = os.path.join(REPO, rel)
            try:
                with open(path, encoding="utf-8", errors="ignore") as f:
                    text = f.read()
            except OSError:
                continue
            for m in ID_RE.finditer(text):
                found.setdefault(m.group(0), set()).add(rel)
        return found

    # Fallback when git cannot answer at all. The MIN_REPO_IDS floor still
    # guards this path, so a broken walk cannot read as clean either.
    for root, dirs, files in os.walk(REPO):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for name in files:
            if not name.endswith(SCAN_EXTS):
                continue
            path = os.path.join(root, name)
            try:
                with open(path, encoding="utf-8", errors="ignore") as f:
                    text = f.read()
            except OSError:
                continue
            for m in ID_RE.finditer(text):
                found.setdefault(m.group(0), set()).add(
                    os.path.relpath(path, REPO))
    return found


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("--out", default=os.path.join(REPO, "monitoring"))
    p.add_argument("--json", action="store_true")
    p.add_argument("--schema-file", help="read a snapshot instead of calling Airtable")
    # Injectable so tests are deterministic. A test that derives the date
    # itself has to guess which clock this script read: the test used UTC
    # (new Date().toISOString()) while this used LOCAL time, so for the one
    # hour after midnight in BST they disagreed and the suite failed for a
    # reason that had nothing to do with drift (27 Aug 2026).
    p.add_argument("--today", help="override today's date (YYYY-MM-DD), for tests")
    a = p.parse_args(argv)

    # LOCAL time on purpose: the monitoring reports are filed by local day and
    # Kevin reads them that way. The one rule is that everything downstream
    # uses THIS value, never its own clock read.
    today = a.today or datetime.now().strftime("%Y-%m-%d")

    if a.schema_file:
        try:
            with open(a.schema_file) as f:
                schema = json.load(f)
            err = None
        except (OSError, ValueError) as e:
            schema, err = None, "cannot read %s: %s" % (a.schema_file, e)
    else:
        schema, err = fetch_schema()
    if err:
        code, res = fail(err, "No snapshot means no verdict. Treat as broken.")
        return emit(code, res, a)

    # CONTROL 1 — a plausible-looking short read is the failure mode here.
    if len(schema) < MIN_TABLES:
        code, res = fail(
            "schema returned only %d tables (floor %d)" % (len(schema), MIN_TABLES),
            "A revoked token, a wrong base id or a changed endpoint all return "
            "something that looks like a schema. Refusing to diff against it.")
        return emit(code, res, a)

    os.makedirs(a.out, exist_ok=True)
    snap_path = os.path.join(a.out, "schema-%s.json" % today)

    # Diff against the most recent EARLIER snapshot, never today's own.
    prior_path, prior = None, None
    # STRICTLY EARLIER than today. Excluding only "schema-<today>.json" was not
    # enough: the names sort lexicographically, so any snapshot dated today or
    # later would be picked as the "prior" one and the scan would diff a
    # snapshot against itself (or against the future) and report clean for ever.
    def snap_date(name):
        """The YYYY-MM-DD in "schema-<date>.json", or None if it is not one."""
        stem = name[len("schema-"):-len(".json")]
        return stem if re.fullmatch(r"\d{4}-\d{2}-\d{2}", stem) else None

    snaps = sorted(f for f in os.listdir(a.out)
                   if f.startswith("schema-") and f.endswith(".json")
                   and snap_date(f) is not None
                   and snap_date(f) < today)
    if snaps:
        prior_path = os.path.join(a.out, snaps[-1])
    elif os.path.exists(os.path.join(a.out, "schema-baseline.json")):
        prior_path = os.path.join(a.out, "schema-baseline.json")
    if prior_path:
        try:
            with open(prior_path) as f:
                prior = json.load(f)
        except (OSError, ValueError):
            prior = None

    with open(snap_path, "w") as f:
        json.dump(schema, f, indent=1, sort_keys=True)

    changes = diff_schema(schema, prior) if prior else None

    # CONTROL 2 — an empty reference map resolves nothing and passes for ever.
    map_path = os.path.join(a.out, "reference-map.json")
    try:
        with open(map_path) as f:
            ref = json.load(f)
    except (OSError, ValueError) as e:
        code, res = fail("cannot read the reference map: %s" % e,
                         "%s is what DEAD is measured against." % map_path)
        return emit(code, res, a)
    mapped = dict(ref.get("fields", {}))
    mapped.update(ref.get("tables", {}))
    if not mapped:
        code, res = fail("the reference map is empty",
                         "Resolving nothing against anything passes for ever.")
        return emit(code, res, a)

    live = known_ids(schema)
    dead_mapped = sorted(i for i in mapped if i not in live)

    # CONTROL 3 — the silent zero. A regex typo finds nothing and reads clean.
    repo_ids = scan_repo()
    if len(repo_ids) < MIN_REPO_IDS:
        code, res = fail(
            "repo scan found only %d Airtable ids (floor %d)" % (len(repo_ids), MIN_REPO_IDS),
            "A broken pattern returns zero matches and reads as 'no rogue "
            "references, all clean'. Refusing to report that.")
        return emit(code, res, a)

    # rec/sel ids are absent from the compact snapshot by design, so only
    # fld/tbl can be judged dead here.
    unresolved = sorted(
        i for i in repo_ids
        if i[:3] in ("fld", "tbl") and i not in live and i not in mapped)

    res = {
        "ok": True,
        "date": today,
        "tables": len(schema),
        "fields": sum(len(t["fields"]) for t in schema.values()),
        "compared_against": os.path.basename(prior_path) if prior_path else None,
        "schema_changes": changes,
        "mapped_ids": len(mapped),
        "dead_mapped_ids": dead_mapped,
        "repo_ids_scanned": len(repo_ids),
        "unresolvable_repo_ids": {i: sorted(repo_ids[i]) for i in unresolved},
        "snapshot": os.path.relpath(snap_path, REPO),
    }

    # WHAT CAN ACTUALLY BREAK.
    #
    # Adding a table or a field cannot break anything: no code can already
    # reference something that did not exist until today. Every other kind of
    # change can, and two of them are invisible to BOTH id checks above,
    # because a rename or a retype keeps the same id alive — dead_mapped and
    # unresolved sail straight past while a name-matched filterByFormula
    # silently returns zero rows and a typed write silently writes the wrong
    # shape. Removals are treated the same way and for the same reason: this
    # codebase references fields by NAME inside formulas, which no id scan can
    # see.
    #
    # This is the judgement the daily-ops runbook already asked a human to make
    # by hand every morning — "a new table with no repo consumers is usually
    # expected and needs nothing; a removed or retyped field that config.js
    # maps is a live break; a renamed field is the dangerous quiet one".
    # Putting it in the exit code is the whole point. Before this, ONE field we
    # had added ourselves the day before turned this job red directly beside
    # data-invariants reporting a 28-day-old council tax summons, at identical
    # severity, one line apart (28 Aug 2026). Two alarms of equal weight where
    # one is always noise is how the real one stops being read.
    #
    # ADDITIVE is the allow-list, not BREAKING, so a change category added to
    # diff_schema() later is treated as breaking until someone decides
    # otherwise. Unknown means loud.
    ADDITIVE = ("new_tables", "new_fields")
    additions = {k: v for k, v in (changes or {}).items() if k in ADDITIVE and v}
    breaking = {k: v for k, v in (changes or {}).items() if k not in ADDITIVE and v}

    # Whether an addition is already wired up, which is what distinguishes a
    # field we added on purpose yesterday from one that appeared in Airtable
    # with nothing in the repo expecting it. Neither breaks anything; the
    # difference is worth a word in the report rather than an alarm.
    known_new = []
    for entries in additions.values():
        for line in entries:
            m = re.search(r"\((fld|tbl)[A-Za-z0-9]{14}\)$", line)
            if m and (m.group(0)[1:-1] in mapped or m.group(0)[1:-1] in repo_ids):
                known_new.append(line)

    drifted = bool(dead_mapped) or bool(unresolved) or bool(breaking)
    res["breaking_changes"] = sorted(breaking)
    res["additions_already_referenced"] = known_new
    res["verdict"] = ("DRIFT" if drifted
                      else "ADDITIONS" if additions
                      else "CLEAN")
    if not prior:
        res["note"] = ("no earlier snapshot to compare against; today's is now "
                       "the baseline")

    if drifted:
        exc = os.path.join(a.out, "drift-exceptions-%s.json" % today)
        with open(exc, "w") as f:
            json.dump(res, f, indent=2)
        res["exceptions_file"] = os.path.relpath(exc, REPO)
        return emit(1, res, a)
    return emit(0, res, a)


def emit(code, res, a):
    # A control failure goes to stderr whatever the output mode. This runs as a
    # wrapped launchd job, and stderr is what the queue captures and what a
    # human reads when the job goes red. Burying the reason inside --json
    # output would make the loudest failure the quietest one.
    if code == 2:
        print("CANNOT VERIFY: %s" % res["reason"], file=sys.stderr)
        print("    %s" % res.get("detail", ""), file=sys.stderr)
    if a.json:
        print(json.dumps(res, indent=2))
        return code
    if code == 2:
        return code
    print("%s: %d tables, %d fields, %d repo ids scanned"
          % (res["verdict"], res["tables"], res["fields"], res["repo_ids_scanned"]))
    ch = res.get("schema_changes")
    if ch:
        for k, v in ch.items():
            for line in v:
                print("    %-16s %s" % (k, line))
    # Say why this is not an alarm, in the same breath as the change itself.
    # A bare list of new fields under a green exit invites the reader to wonder
    # whether something was missed.
    if res.get("verdict") == "ADDITIONS":
        print("    no action: additions only, and nothing already written can "
              "reference a field that did not exist until today")
        known = res.get("additions_already_referenced") or []
        if known:
            print("    %d of %d already referenced in the repo, so they were "
                  "added on purpose"
                  % (len(known), sum(len(v) for v in ch.values())))
    for i in res.get("dead_mapped_ids", []):
        print("    DEAD (config)    %s" % i)
    for i, files in res.get("unresolvable_repo_ids", {}).items():
        print("    UNRESOLVABLE     %s  in %s" % (i, ", ".join(files)))
    if res.get("note"):
        print("    note: %s" % res["note"])
    if res.get("exceptions_file"):
        print("    exceptions: %s" % res["exceptions_file"])
    return code


if __name__ == "__main__":
    sys.exit(main())
