#!/usr/bin/env python3
"""Delete the re-imported duplicate transactions, keeping the ORIGINAL of each pair.

Re-derives the duplicate set live every run — never trusts a saved id list, which
would go stale the moment anything else touched the table.

Safety rules, all of which must hold for a record to be deleted:
  1. It shares its bank transactionId with an older record (that older one is kept).
  2. It is the NEWER copy.
  3. It is NOT reconciled.
  4. It carries NO Chart of Accounts category, sub-category, cost, property or tenancy.
A candidate that breaks a rule is SKIPPED and reported, never deleted. The rules
protect individual records; they are not a demand that the whole table be pristine.
A reconciled, categorised duplicate is somebody's decision to unpick by hand.

Dry run by default. Pass --confirm to actually delete.
"""
import json, os, re, sys, urllib.parse, urllib.request

PAT = open(os.path.expanduser("~/.config/od/airtable_pat")).read().strip()
BASE, TX = "appnqjDpqDniH3IRl", "tbln0gzhCAorFc3zB"
FIELDS = ["**Raw", "**Plaid TX ID", "Account Alias (from **Account)", "**GBP", "**Date",
          "Created", "Reconciled", "*Name", "Chart of Accounts - Category",
          "Chart of Accounts - Sub Category", "Costs", "Property", "Tenancy"]
CLEAN = ["Chart of Accounts - Category", "Chart of Accounts - Sub Category",
         "Costs", "Property", "Tenancy"]


def api(method, path, body=None):
    req = urllib.request.Request(
        f"https://api.airtable.com/v0/{BASE}/{path}",
        data=(json.dumps(body).encode() if body else None), method=method,
        headers={"Authorization": f"Bearer {PAT}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def scan():
    out, offset = [], None
    while True:
        q = [("pageSize", "100")] + [("fields[]", f) for f in FIELDS]
        if offset:
            q.append(("offset", offset))
        d = api("GET", f"{TX}?" + urllib.parse.urlencode(q))
        out += d["records"]
        offset = d.get("offset")
        if not offset:
            return out


def bank_id(r):
    m = re.search(r'"transactionId"\s*:\s*"([^"]+)"', r["fields"].get("**Raw") or "")
    return m.group(1) if m else None


records = scan()
groups = {}
for r in records:
    b = bank_id(r)
    if b:
        groups.setdefault(b, []).append(r)

doomed, refusals = [], []
for b, copies in groups.items():
    if len(copies) < 2:
        continue
    copies.sort(key=lambda x: x["fields"].get("Created", ""))
    keep, extras = copies[0], copies[1:]
    for e in extras:
        f = e["fields"]
        why = []
        if f.get("Reconciled"):
            why.append("already reconciled")
        dirty = [c for c in CLEAN if f.get(c)]
        if dirty:
            why.append("carries " + ", ".join(dirty))
        if why:
            refusals.append((b, e["id"], f.get("**Date"), f.get("**GBP"), "; ".join(why)))
        else:
            doomed.append((b, e, keep))

print(f"scanned {len(records)} transactions, {sum(1 for r in records if bank_id(r))} carrying a bank id")
print(f"duplicate groups: {sum(1 for c in groups.values() if len(c) > 1)}")
print(f"deletable extra copies: {len(doomed)}")
print(f"REFUSED (not safe to delete): {len(refusals)}")
for b, rid, d, amt, why in refusals:
    print(f"   {rid} {d} {amt} — {why}")

gross_in = sum(float(e["fields"].get("**GBP") or 0) for _, e, _ in doomed if float(e["fields"].get("**GBP") or 0) > 0)
gross_out = sum(float(e["fields"].get("**GBP") or 0) for _, e, _ in doomed if float(e["fields"].get("**GBP") or 0) < 0)
print(f"removes £{gross_in:,.2f} of phantom inflow and £{abs(gross_out):,.2f} of phantom outflow")

if "--confirm" not in sys.argv:
    print("\nDRY RUN — nothing deleted. Re-run with --confirm to apply.")
    for _, e, keep in doomed[:5]:
        f = e["fields"]
        print(f"   would delete {e['id']} ({f.get('**Date')} {f.get('**GBP')}) keeping {keep['id']} "
              f"created {keep['fields'].get('Created', '')[:10]}")
    sys.exit(0)

if refusals:
    print(f"\nLeaving {len(refusals)} reconciled/categorised copies in place — each needs its own call.")

ids = [e["id"] for _, e, _ in doomed]
deleted = 0
for i in range(0, len(ids), 10):
    batch = ids[i:i + 10]
    q = urllib.parse.urlencode([("records[]", r) for r in batch])
    api("DELETE", f"{TX}?{q}")
    deleted += len(batch)
    print(f"   deleted {deleted}/{len(ids)}")
print(f"\nDone. {deleted} duplicate records removed.")
