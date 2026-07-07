#!/usr/bin/env python3
"""
Nightly mirror: Airtable "AI Brain Today" feed  ->  Supabase `ai_brain_today`.

The feed (Airtable table tblZ75JgE1wzDP0ps) is regenerated each night by external
automation (notes 22:40, meetings 22:45, tidy 23:00). This mirrors the CURRENT
feed into Supabase so the Supabase clone shows the same day's brain:
  - upsert every current Airtable row (id + its name-keyed `fields`)
  - delete any Supabase rows no longer in Airtable (the feed is a daily replace)

Airtable's REST API returns fields keyed by NAME by default — exactly the shape
the ai_brain_today.fields jsonb needs, so no field-id mapping. Idempotent; safe to
run on a schedule. Read-only on Airtable.

Env (same secrets as the Fintable sync — already set on the repo):
  AIRTABLE_PAT          Airtable PAT (data.records:read on the base)
  SUPABASE_URL          e.g. https://xxxx.supabase.co
  SUPABASE_SERVICE_KEY  Supabase service_role key (server-side only)
"""
import os, sys, json, urllib.request, urllib.parse, urllib.error

_missing = [k for k in ("AIRTABLE_PAT", "SUPABASE_URL", "SUPABASE_SERVICE_KEY") if not os.environ.get(k)]
if _missing:
    print("Skipping sync — add these GitHub repo secrets first:", ", ".join(_missing))
    sys.exit(0)

PAT   = os.environ["AIRTABLE_PAT"].strip()
SB    = os.environ["SUPABASE_URL"].strip().rstrip("/")
KEY   = os.environ["SUPABASE_SERVICE_KEY"].strip()
BASE  = os.environ.get("AIRTABLE_BASE_ID", "appnqjDpqDniH3IRl")
TABLE = "tblZ75JgE1wzDP0ps"   # AI Brain Today feed


def airtable_all():
    """Every row in the feed, fields keyed by NAME (Airtable REST default)."""
    out, offset = [], None
    while True:
        q = [("pageSize", "100")]
        if offset:
            q.append(("offset", offset))
        url = f"https://api.airtable.com/v0/{BASE}/{TABLE}?" + urllib.parse.urlencode(q)
        req = urllib.request.Request(url, headers={"Authorization": f"Bearer {PAT}"})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                d = json.load(r)
        except urllib.error.HTTPError as e:
            print(f"Airtable read FAILED: HTTP {e.code} — {e.read().decode()[:200]}")
            print("→ Check AIRTABLE_PAT: correct token, data.records:read on the base, no stray spaces.")
            sys.exit(1)
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


def main():
    recs = airtable_all()
    rows = [{"id": r["id"], "fields": r.get("fields", {})} for r in recs]
    print(f"{len(rows)} row(s) in the Airtable AI Brain feed")
    keep = {r["id"] for r in rows}

    # 1) upsert the current feed
    if rows:
        s, b = sb("POST", "/rest/v1/ai_brain_today?on_conflict=id", rows,
                  "resolution=merge-duplicates,return=minimal")
        if s >= 300:
            print(f"Supabase upsert FAILED: HTTP {s} — {b[:200]}")
            sys.exit(1)
        print(f"  upserted {len(rows)} row(s)")

    # 2) delete rows no longer in the feed (daily replace)
    s, b = sb("GET", "/rest/v1/ai_brain_today?select=id")
    existing = {row["id"] for row in json.loads(b)} if s == 200 else set()
    stale = existing - keep
    if stale:
        ids = ",".join(stale)   # rec ids are alphanumeric — safe unquoted
        s, b = sb("DELETE", f"/rest/v1/ai_brain_today?id=in.({ids})", None, "return=minimal")
        print(f"  removed {len(stale)} stale row(s)" if s < 300 else f"  delete FAILED HTTP {s}: {b[:200]}")

    print("AI Brain mirror complete.")


if __name__ == "__main__":
    main()
