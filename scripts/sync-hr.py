#!/usr/bin/env python3
"""
One-off / repeatable copy of the HR page's data  ->  Supabase.

Fills the pieces the Team/HR Supabase page (os/team/index-supabase.html + team-shim.js)
needs beyond the Module-1 team_members already migrated:

  1. team_members.hr_fields  — the extra NON-SENSITIVE profile fields (handbook,
     constraints, role/values Q&A, expected weekly, emergency contact, vision board,
     PR date). Matched to Supabase by record id (team_members.id == Airtable rec id).
  2. performance_reviews     — every Performance Reviews row (id-keyed `fields` blob).
  3. dod                     — every DOD (per-SOP training) row (id-keyed `fields` blob).

SENSITIVE FIELDS (pay rate + bank details) are NEVER copied — see DROP below.
Idempotent (upserts by id); read-only on Airtable. Run after migration 0042.

Env (same secrets as the other sync scripts):
  AIRTABLE_PAT          Airtable PAT (data.records:read on the base)
  SUPABASE_URL          e.g. https://xxxx.supabase.co
  SUPABASE_SERVICE_KEY  Supabase service_role key (server-side only)
"""
import os, sys, json, urllib.request, urllib.parse, urllib.error

_missing = [k for k in ("AIRTABLE_PAT", "SUPABASE_URL", "SUPABASE_SERVICE_KEY") if not os.environ.get(k)]
if _missing:
    print("Skipping — set these first:", ", ".join(_missing)); sys.exit(0)

PAT  = os.environ["AIRTABLE_PAT"].strip()
SB   = os.environ["SUPABASE_URL"].strip().rstrip("/")
KEY  = os.environ["SUPABASE_SERVICE_KEY"].strip()
BASE = os.environ.get("AIRTABLE_BASE_ID", "appnqjDpqDniH3IRl")

TEAM_TABLE = "tblco0p2OnlLQVAX7"
PR_TABLE   = "tblfsuNXU9HRN4d9f"
DOD_TABLE  = "tbltrOX1yyiuUuW59"
PR_MEMBER_FIELD = "fld92bhCxJHTsXabB"   # Team Member link on a review

# extra non-sensitive HR fields on team_members: Airtable field id -> hr_fields key
HR_FIELDS = {
    "fldEIwDJhvGJ8FTgH": "handbook_link", "fldvjbOZ7ejbFOQK9": "constraints",
    "fldz7qEmMCPqowtv4": "expected_weekly", "fldvW1nHNeMb817N8": "vision_board",
    "fldcDbWN6n7ja31RM": "emergency_name", "fldzlBLXXCL1u55HH": "emergency_phone",
    "fldw28xtoxwSJgH2Z": "manager_email", "fldMz4jWtPL3WAJ55": "pr_date",
    "fldYtFQuL1asBE07O": "role_q1", "fldbkTXzx9FW5UEfi": "role_q2", "fldon0ExmdR0iMIQk": "role_q3",
    "fldXvdy9rlO2TLqYw": "val_q1", "fldZwfiKIaJGflaDj": "val_q2", "fldV82hlqXrrmTf6s": "val_q3",
}
# pay rate + bank details — NEVER copy to Supabase
DROP = {"fldQjulT29GI0qk5g", "fldYBMmRA17CDXLOK", "fld2dt7AcXnbRDNa1",
        "fld4EqMDKgx00Zshe", "fldPaMgmtF3qx1uFz", "fldOhos4hwNDEiJuL", "fld2XUP3uCax41QT8"}


def airtable_all(table, by_field_id=True):
    out, offset = [], None
    while True:
        q = [("pageSize", "100")]
        if by_field_id:
            q.append(("returnFieldsByFieldId", "true"))
        if offset:
            q.append(("offset", offset))
        url = f"https://api.airtable.com/v0/{BASE}/{table}?" + urllib.parse.urlencode(q)
        req = urllib.request.Request(url, headers={"Authorization": f"Bearer {PAT}"})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                d = json.load(r)
        except urllib.error.HTTPError as e:
            print(f"Airtable read of {table} FAILED: HTTP {e.code} — {e.read().decode()[:200]}"); sys.exit(1)
        out += d["records"]
        offset = d.get("offset")
        if not offset:
            break
    return out


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


def strip_sensitive(fields):
    return {k: v for k, v in (fields or {}).items() if k not in DROP}


def main():
    # 1) team_members.hr_fields (match by id; PATCH each with a non-empty hr blob)
    members = airtable_all(TEAM_TABLE)
    patched = 0
    for r in members:
        f = r.get("fields", {})
        hr = {col: f[fid] for fid, col in HR_FIELDS.items() if fid in f and f[fid] not in (None, "", [])}
        if not hr:
            continue
        s, b = sb("PATCH", f"/rest/v1/team_members?id=eq.{urllib.parse.quote(r['id'])}",
                  {"hr_fields": hr}, "return=minimal")
        if s >= 300:
            print(f"  team_members {r['id']} PATCH failed HTTP {s}: {b[:150]}")
        else:
            patched += 1
    print(f"team_members: hr_fields set on {patched}/{len(members)} members (bank/pay excluded)")

    # 2) performance_reviews (upsert id + blob + member link)
    for table, dest, member_field in ((PR_TABLE, "performance_reviews", PR_MEMBER_FIELD),
                                      (DOD_TABLE, "dod", None)):
        recs = airtable_all(table)
        rows = []
        for r in recs:
            f = strip_sensitive(r.get("fields", {}))
            row = {"id": r["id"], "fields": f}
            if member_field:
                link = f.get(member_field)
                row["team_member_id"] = link[0] if isinstance(link, list) and link else None
            rows.append(row)
        if rows:
            s, b = sb("POST", f"/rest/v1/{dest}?on_conflict=id", rows,
                      "resolution=merge-duplicates,return=minimal")
            if s >= 300:
                print(f"  {dest} upsert FAILED HTTP {s}: {b[:200]}"); sys.exit(1)
        print(f"{dest}: upserted {len(rows)} row(s)")

    print("HR data copy complete.")


if __name__ == "__main__":
    main()
