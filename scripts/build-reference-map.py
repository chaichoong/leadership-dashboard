#!/usr/bin/env python3
"""Record the field TYPE the code expects, alongside the id it already maps.

WHY THIS EXISTS (16 Sep 2026, finding 20260814-drift-monitor-127)
-----------------------------------------------------------------
`monitoring/reference-map.json` is what drift-scan.py measures DEAD references
against: every Airtable id `js/config.js` mentions, mapped to its JS constant
name. CHECK 2 of drift-monitor/SKILL.md has always asked for a second verdict
off the same map — TYPE_MISMATCH, "field exists but type changed, e.g.
singleLineText -> number". It could never fire. The map stored a name and
nothing else, so there was no expected type to compare, and the check reported
zero every day for a month while reading as clean.

This writes a `fieldTypes` block: `{fieldId: "currency"}` for every mapped field
the base still has. The existing `fields` / `tables` / `records` /
`selectChoices` blocks are left exactly as they are, so nothing that reads the
map today changes shape.

WHAT "EXPECTED" MEANS HERE
--------------------------
Today's live type. That is the honest baseline and the only one available: this
codebase has never written its expectations down, so the first snapshot of them
is the current truth. From the moment it is committed, any retype upstream is a
difference the scan reports — which is the whole point, and is a stronger check
than the snapshot diff, because it holds even across days the job did not run.

A field in the map that is NOT in the base is left untyped on purpose. It is a
dead reference, drift-scan already reports it as DEAD, and inventing a type for
it would move it out of the check that owns it.

Usage:
    python3 scripts/build-reference-map.py            # rewrite in place
    python3 scripts/build-reference-map.py --check    # exit 1 if it is stale
Auth: ~/.config/od/airtable_pat (never printed).
"""

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import importlib.util

_SPEC = importlib.util.spec_from_file_location(
    "drift_scan", os.path.join(os.path.dirname(os.path.abspath(__file__)), "drift-scan.py"))
drift_scan = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(drift_scan)

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MAP = os.path.join(REPO, "monitoring", "reference-map.json")


def live_field_types(schema):
    out = {}
    for t in schema.values():
        for fid, f in t["fields"].items():
            out[fid] = f.get("type")
    return out


def build(ref, types):
    """The fieldTypes block for this map, sorted so the diff is readable."""
    mapped = set(ref.get("fields", {})) | set(ref.get("tables", {}))
    return {fid: types[fid] for fid in sorted(mapped) if fid in types}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true",
                    help="report staleness and exit 1, write nothing")
    ap.add_argument("--schema-file", help="read the schema from a file (tests)")
    a = ap.parse_args()

    if a.schema_file:
        with open(a.schema_file) as f:
            schema = json.load(f)
    else:
        schema, err = drift_scan.fetch_schema()
        if err:
            sys.exit("cannot read the base schema: %s" % err)
    # The same floor drift-scan refuses on. A short read here would write a
    # map that declares most of the base dead.
    if len(schema) < drift_scan.MIN_TABLES:
        sys.exit("schema returned only %d tables (floor %d); refusing to write"
                 % (len(schema), drift_scan.MIN_TABLES))

    with open(MAP) as f:
        ref = json.load(f)
    fresh = build(ref, live_field_types(schema))
    current = ref.get("fieldTypes") or {}

    if a.check:
        if current == fresh:
            print("reference-map.json fieldTypes: current (%d fields)" % len(fresh))
            return 0
        added = sorted(set(fresh) - set(current))
        gone = sorted(set(current) - set(fresh))
        moved = sorted(k for k in fresh if k in current and current[k] != fresh[k])
        print("reference-map.json fieldTypes is STALE: "
              "%d new, %d no longer live, %d retyped" % (len(added), len(gone), len(moved)))
        for k in moved[:20]:
            print("  RETYPED %s: recorded %s, live %s" % (k, current[k], fresh[k]))
        return 1

    ref["fieldTypes"] = fresh
    summary = ref.setdefault("summary", {})
    if isinstance(summary, dict):
        summary["fieldTypes"] = len(fresh)
    with open(MAP, "w") as f:
        json.dump(ref, f, indent=1, sort_keys=True)
        f.write("\n")
    print("wrote %d field types to %s" % (len(fresh), os.path.relpath(MAP, REPO)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
