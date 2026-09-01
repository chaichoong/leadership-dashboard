#!/usr/bin/env python3
"""
Copy Debt Terms (Airtable tblTz8ErAmQGu7rIZ) -> Supabase `debt_terms`.

The Wealth tab reads debt terms by FIELD ID (returnFieldsByFieldId=true) to build
liabilities + the Payment Match credit-card matching. So we read id-keyed and store
each row's cellValuesByFieldId as the `fields` jsonb blob (selects come back as
plain name strings under that mode — exactly what the page expects).

Idempotent (upsert by id = Airtable rec id); read-only on Airtable. Data is copied
at RUNTIME and never committed — Debt Terms holds balances, card numbers and
sensitive legal notes, and this repo is public.

Env (same secrets as the other sync jobs):
  AIRTABLE_PAT · SUPABASE_URL · SUPABASE_SERVICE_KEY
"""
import os, sys, json, urllib.request, urllib.parse, urllib.error

_missing = [k for k in ("AIRTABLE_PAT", "SUPABASE_URL", "SUPABASE_SERVICE_KEY") if not os.environ.get(k)]
if _missing:
    print("Skipping — set these first:", ", ".join(_missing)); sys.exit(0)

PAT  = os.environ["AIRTABLE_PAT"].strip()
SB   = os.environ["SUPABASE_URL"].strip().rstrip("/")
KEY  = os.environ["SUPABASE_SERVICE_KEY"].strip()
BASE = os.environ.get("AIRTABLE_BASE_ID", "appnqjDpqDniH3IRl")
TABLE = "tblTz8ErAmQGu7rIZ"


def airtable_all():
    """Every debt-term row, fields keyed by field ID; selects normalised to their name string."""
    out, offset = [], None
    while True:
        q = [("pageSize", "100"), ("returnFieldsByFieldId", "true")]
        if offset:
            q.append(("offset", offset))
        url = f"https://api.airtable.com/v0/{BASE}/{TABLE}?" + urllib.parse.urlencode(q)
        req = urllib.request.Request(url, headers={"Authorization": f"Bearer {PAT}"})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                d = json.load(r)
        except urllib.error.HTTPError as e:
            print(f"Airtable read FAILED: HTTP {e.code} — {e.read().decode()[:200]}"); sys.exit(1)
        out += d["records"]
        offset = d.get("offset")
        if not offset:
            break
    return out


def norm(v):
    # singleSelect → name string; multipleSelects → list of names; else verbatim.
    if isinstance(v, dict) and "name" in v:
        return v["name"]
    if isinstance(v, list):
        return [x["name"] if isinstance(x, dict) and "name" in x else x for x in v]
    return v


def sb(method, path, body=None, prefer=None):
    h = {"apikey": KEY, "Authorization": f"Bearer {KEY}", "Content-Type": "application/json"}
    if prefer:
        h["Prefer"] = prefer
    req = urllib.request.Request(SB + path,
                                 data=(json.dumps(body).encode() if body is not None else None),
                                 method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=60) as x:
            return x.status, x.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def main():
    recs = airtable_all()
    rows = [{"id": r["id"], "fields": {k: norm(v) for k, v in (r.get("fields", {}) or {}).items()}} for r in recs]
    print(f"{len(rows)} debt-term row(s) in Airtable")
    if rows:
        s, b = sb("POST", "/rest/v1/debt_terms?on_conflict=id", rows,
                  "resolution=merge-duplicates,return=minimal")
        if s >= 300:
            print(f"Supabase upsert FAILED: HTTP {s} — {b[:200]}"); sys.exit(1)
        print(f"  upserted {len(rows)} row(s) into debt_terms")
    print("Debt Terms copy complete.")


if __name__ == "__main__":
    main()
