#!/usr/bin/env python3
"""
Incremental bank-transaction sync: Airtable (Fintable feed) -> Supabase.

Fintable writes new bank transactions into the Airtable Transactions table.
This mirrors any transaction created/edited in the last N days into the Supabase
`transactions` table. Idempotent (upsert on id) — safe to run on a schedule.

Env:
  AIRTABLE_PAT          Airtable personal access token (data.records:read on the base)
  SUPABASE_URL          e.g. https://xxxx.supabase.co
  SUPABASE_SERVICE_KEY  Supabase service_role key (server-side only)
  SYNC_WINDOW_DAYS      optional, default 3 — re-sync window (overlap = safety)
"""
import os, sys, json, urllib.request, urllib.parse, urllib.error

_missing = [k for k in ("AIRTABLE_PAT", "SUPABASE_URL", "SUPABASE_SERVICE_KEY") if not os.environ.get(k)]
if _missing:
    print("Skipping sync — add these GitHub repo secrets first:", ", ".join(_missing))
    sys.exit(0)

PAT  = os.environ["AIRTABLE_PAT"].strip()          # .strip() defends against a
SB   = os.environ["SUPABASE_URL"].strip().rstrip("/")  # stray newline/space when the
KEY  = os.environ["SUPABASE_SERVICE_KEY"].strip()      # secret was pasted into GitHub
BASE = os.environ.get("AIRTABLE_BASE_ID", "appnqjDpqDniH3IRl")
WIN  = int(os.environ.get("SYNC_WINDOW_DAYS", "3"))
TX_TABLE = "tbln0gzhCAorFc3zB"

F = dict(name="fldsbuAJCTsXHug4C", date="fldoyQ6Rr9cHp3bgQ", amt="fldN01r1hp7UQjgtm",
    rep="fldot7iisZeL3WrdR", orig="fldh711ChnFGDvh1u", sc="fld20FWX7yjM8P2Kz",
    so="fldQ37YsyR9r3EbkP", ss="fld7gZxUldVLZXnAB", rec="fldxKX1IbIFcAOnn5",
    ven="fld0Xr8sboQ0ekJQJ", aa="fldBrjlbeaKFm3WzQ", inv="fldT5qfiyt5DTLrp8",
    sub="fldMRjSVzZVYeHb0A", catl="fldFPmNixqHPQy4D6", tenl="fldPmAMmxwqs4SdPa",
    unitl="fldJGIhSbgXNIEW4a", propl="fldvp44VfF8uTTthp", costl="fldGkpkVqSeiGvUGL",
    accl="fld9hm24JQUPOCoWj", bizl="fldX1aFlJyzpXGhbF", tml="fldMwliSwEhLuumvd")

# ── helpers ──
f = lambda r, k: r["fields"].get(k)
def first(r, k):
    v = r["fields"].get(k)
    return (v[0] if isinstance(v, list) and v else (None if isinstance(v, list) else v))
def num(v):
    try: return float(v) if v not in (None, "") else None
    except: return None
def integer(v):
    n = num(v); return int(n) if n is not None else None
def sel(v): return v.get("name") if isinstance(v, dict) else v
def alias(v): return (v[0] if isinstance(v, list) and v else (v if isinstance(v, str) else None))

def airtable_recent():
    """Transactions created OR edited in the last WIN days."""
    formula = f"IS_AFTER(LAST_MODIFIED_TIME(), DATEADD(NOW(), -{WIN}, 'days'))"
    out, offset = [], None
    while True:
        q = [("returnFieldsByFieldId", "true"), ("pageSize", "100"), ("filterByFormula", formula)]
        for fid in F.values(): q.append(("fields[]", fid))
        if offset: q.append(("offset", offset))
        url = f"https://api.airtable.com/v0/{BASE}/{TX_TABLE}?" + urllib.parse.urlencode(q)
        req = urllib.request.Request(url, headers={"Authorization": f"Bearer {PAT}"})
        try:
            with urllib.request.urlopen(req, timeout=60) as r: d = json.load(r)
        except urllib.error.HTTPError as e:
            print(f"Airtable read FAILED: HTTP {e.code} — {e.read().decode()[:200]}")
            print("→ Check the AIRTABLE_PAT secret: correct token, has data.records:read on the base, no stray spaces.")
            sys.exit(1)
        out += d["records"]; offset = d.get("offset")
        if not offset: break
    return out

def sb(method, path, body=None, prefer=None):
    h = {"apikey": KEY, "Authorization": f"Bearer {KEY}", "Content-Type": "application/json"}
    if prefer: h["Prefer"] = prefer
    req = urllib.request.Request(SB + path, data=(json.dumps(body).encode() if body is not None else None),
                                 method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=60) as x: return x.status, x.read().decode()
    except urllib.error.HTTPError as e: return e.code, e.read().decode()

def id_set(table):
    s, b = sb("GET", f"/rest/v1/{table}?select=id")
    return {row["id"] for row in json.loads(b)} if s == 200 else set()

def main():
    print(f"Syncing transactions modified in the last {WIN} days…")
    recs = airtable_recent()
    print(f"  {len(recs)} candidate transaction(s) from Airtable")
    if not recs:
        print("Nothing to sync."); return

    # FK guards — only set a link if its target exists in Supabase
    P = {t: id_set(t) for t in ["costs","tenancies","rental_units","properties","accounts",
                                "coa_categories","coa_sub_categories","businesses","team_members"]}
    def fk(v, table): return v if v in P[table] else None

    rows = []
    for r in recs:
        rows.append(dict(
            id=r["id"], name=f(r, F["name"]), date=f(r, F["date"]) or None, amount=num(f(r, F["amt"])),
            report_amount=num(f(r, F["rep"])), original_amount=num(f(r, F["orig"])),
            split_count=(integer(f(r, F["sc"])) or 1), split_override=num(f(r, F["so"])),
            split_status=sel(f(r, F["ss"])), reconciled=bool(f(r, F["rec"])), vendor=f(r, F["ven"]),
            account_alias=alias(f(r, F["aa"])), invoice_data=f(r, F["inv"]),
            sub_category_id=fk(first(r, F["sub"]), "coa_sub_categories"),
            category_id=fk(first(r, F["catl"]), "coa_categories"),
            tenancy_id=fk(first(r, F["tenl"]), "tenancies"),
            unit_id=fk(first(r, F["unitl"]), "rental_units"),
            property_id=fk(first(r, F["propl"]), "properties"),
            cost_id=fk(first(r, F["costl"]), "costs"),
            account_id=fk(first(r, F["accl"]), "accounts"),
            business_id=fk(first(r, F["bizl"]), "businesses"),
            team_member_id=fk(first(r, F["tml"]), "team_members"),
        ))

    ok, bad = 0, 0
    for i in range(0, len(rows), 200):
        chunk = rows[i:i+200]
        s, b = sb("POST", "/rest/v1/transactions?on_conflict=id", chunk,
                  "resolution=merge-duplicates,return=minimal")
        if s < 300:
            ok += len(chunk)
        else:
            # isolate bad rows so one failure doesn't drop the batch
            for row in chunk:
                s2, b2 = sb("POST", "/rest/v1/transactions?on_conflict=id", [row],
                            "resolution=merge-duplicates,return=minimal")
                if s2 < 300: ok += 1
                else: bad += 1; print(f"  skip {row['id']}: {b2[:120]}")
    print(f"Synced {ok} transaction(s){f', {bad} skipped' if bad else ''}.")
    if ok == 0 and bad:
        print("→ Every upsert failed. Check the SUPABASE_SERVICE_KEY secret (correct service_role key, no stray spaces).")
        sys.exit(1)

if __name__ == "__main__":
    main()
