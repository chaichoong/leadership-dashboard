#!/usr/bin/env python3
"""
Generic Airtable → Supabase MIRROR sync.

Keeps the Supabase copy matched to the live Airtable base (appnqjDpqDniH3IRl).
Every mirrored table is keyed on the Airtable record id == Supabase `id`, and every
upserted row gets org_id = the home org (Kevin's data).

Two shapes of table:
  • COLUMNAR  — each Airtable field id maps to a Supabase column (scalar/num/bool/
                date/datetime/link/linkArr/collab). Field maps are LIFTED VERBATIM
                from the page shims (dashboard-shim.js, os/**/shim.js, wealth-shim.js)
                so the mirror and the app agree on every mapping.
  • JSONB     — the whole record's fields are stored in a `fields` jsonb blob, keyed by
                Airtable field id (returnFieldsByFieldId=true) to match how the shims
                read them. objectives_strategy also derives business_id/business_name/
                quarter/year/created_time filter columns.

Modes:
  (default)     incremental — records modified in the last SYNC_WINDOW_DAYS (~2) days,
                via a LAST_MODIFIED_TIME() filterByFormula (same approach as
                sync-transactions.py). Overlapping window = safety.
  --full        every record in each table (one-time gap-closing refresh).
  --dry-run     read only. Reports, per table, how many Airtable records were read and
                how many WOULD upsert. Writes NOTHING to Supabase.

SKIPPED here (they already have their own live syncs):
  • transactions   → sync-transactions.py
  • ai_brain_today → sync-ai-brain.py

Env (same secrets as sync-transactions.py — already on the repo):
  AIRTABLE_PAT          Airtable PAT (data.records:read on the base)
  SUPABASE_URL          e.g. https://xxxx.supabase.co
  SUPABASE_SERVICE_KEY  Supabase service_role key (server-side only; not needed for --dry-run
                        beyond being present — no writes happen)
  AIRTABLE_BASE_ID      optional, default appnqjDpqDniH3IRl
  SYNC_WINDOW_DAYS      optional, default 2 — incremental re-sync window
"""
import os, sys, json, argparse, urllib.request, urllib.parse, urllib.error

# ── modes ──────────────────────────────────────────────────────────────────────
ap = argparse.ArgumentParser(description="Airtable → Supabase mirror sync")
ap.add_argument("--full", action="store_true", help="sync ALL records (one-time refresh)")
ap.add_argument("--dry-run", action="store_true", help="read only; report counts, write nothing")
ap.add_argument("--only", default="", help="comma-separated table names to limit the run")
ARGS = ap.parse_args()

# ── env ────────────────────────────────────────────────────────────────────────
# For --dry-run we only truly need the Airtable PAT, but we keep the same guard shape
# as the other syncs so a scheduled run fails loudly if a secret is missing.
_need = ("AIRTABLE_PAT",) if ARGS.dry_run else ("AIRTABLE_PAT", "SUPABASE_URL", "SUPABASE_SERVICE_KEY")
_missing = [k for k in _need if not os.environ.get(k)]
if _missing:
    print("Skipping sync — add these GitHub repo secrets first:", ", ".join(_missing))
    sys.exit(0)

PAT  = os.environ["AIRTABLE_PAT"].strip()                     # .strip() defends against a stray
SB   = os.environ.get("SUPABASE_URL", "").strip().rstrip("/") # newline/space when the secret was
KEY  = os.environ.get("SUPABASE_SERVICE_KEY", "").strip()     # pasted into GitHub
BASE = os.environ.get("AIRTABLE_BASE_ID", "appnqjDpqDniH3IRl")
WIN  = int(os.environ.get("SYNC_WINDOW_DAYS", "2"))

HOME_ORG = "600ac348-7a49-4fbb-838f-76ec226344ed"   # Kevin's home org — set on EVERY row, never NULL

# objectives_strategy filter field ids (from strategy-shim.js) — used to derive columns
OS_F_BUSINESS = "fldLt6uDJ2xKCMlj2"
OS_F_QUARTER  = "fldQl2h3gCxYacE1k"
OS_F_YEAR     = "fldARVrVpuCWxufQO"

# ════════════════════════════════════════════════════════════════════════════════
# CONFIG — every mirrored table, its Airtable id, and its field map.
# Maps are lifted verbatim from the page shims (source noted per table). kinds:
#   scalar   text passthrough
#   num      -> float
#   bool     -> bool (coerces true/"yes"/1 …)
#   date     date string passthrough (YYYY-MM-DD)
#   datetime -> ISO string
#   link     Airtable link array -> single id (FK column)
#   linkArr  Airtable link array -> jsonb array of ids (NOT an FK)
#   collab   collaborator {name,email} -> writes name to the column + email to member_email
#   json     attachment/array field -> stored as jsonb as-is
#   textarr  multi-select -> Postgres text[] (JSON array)
# Only columns that actually exist AND are writable are emitted (see WRITABLE below);
# generated/lookup/rollup fields are dropped automatically.
# ════════════════════════════════════════════════════════════════════════════════

COLUMNAR = {
    # ---- os/tasks/supabase-shim.js (Meetings tab) ----
    "meetings": ("tblNodbh9B3WLzCIK", {
        "fldWSPqwJMMAA1mxm": ("name", "scalar"),
        "fldTMJFKGqr9VCTns": ("date", "date"),
        "fldUKM6X8PFxbF1HU": ("status", "scalar"),
        "fldZLnxcXALQj2C97": ("attendees", "linkArr"),
        "fldxLuW7F8e4acS4x": ("ext_attendees", "scalar"),
        "fld7hO6M1Pcsxp1BC": ("summary", "scalar"),
        "fldwkgiZ6JdPBgEeU": ("action_points", "scalar"),
        "fld3NpfT3Sbmy3obd": ("tasks", "linkArr"),
        "fldrHJGXyIVyPlqCA": ("recording", "scalar"),
        "fldAmaevMBxmpezx2": ("source", "scalar"),
    }),
    # ---- dashboard-shim.js ----
    "accounts": ("tbl1nr0EcX2T62KME", {
        "fldqr09KqLGGYCYkC": ("name", "scalar"),
        "fldhDG5jDA8Tu2JyI": ("gbp", "num"),
        "fld8HOlbBrXbHesoA": ("last_update", "datetime"),
        "fld21HAxSawQCxICj": ("account_alias", "scalar"),
        "fldvDKRsMRtIglykK": ("business_id", "link"),
    }),
    "costs": ("tblx5kvhzNEI5TFlS", {
        "fldS6FYfpkhu6tJG0": ("name", "scalar"),
        "fld9JibXkMpTeMcxw": ("expected", "num"),
        "fld7IsfiGvKpxEwSs": ("due_day", "scalar"),
        "fldvozTHvs5VH3lNi": ("frequency", "scalar"),
        "fldXZNI96v8HgjuSh": ("pay_status_legacy", "scalar"),
        "fldQJPGLFMbwVelsW": ("inactive", "bool"),
        "fldQZBF4JzBsmWU87": ("due_date_next", "date"),
        "fldRO90pSCj6ahVMC": ("sub_category_id", "link"),
        "fldrPjvdFPCKWqeyd": ("business_id", "link"),
        "fld7nikJBPz3BoZJG": ("property_id", "link"),
    }),
    # ---- os/operations/supabase-shim.js ----
    "tenancies": ("tblN51a88qTDB6iMH", {
        "fldyNVvFn4x8GY14q": ("ref", "scalar"),
        "fld1i5bDoHL3B6rUf": ("tenant_id", "link"),
        "fld7cjLLEHKAx49OK": ("unit_id", "link"),
        "fldxU3dPUnbK0SCDq": ("pay_status", "scalar"),
        "fld2rPXwwV8dXb1zF": ("start_date", "date"),
        "fldDMyfZLFMeONPq8": ("rent", "num"),
        "fldhy2U0CQmM2oS4P": ("due_day", "scalar"),
        "fld5O24mC8vOezjXK": ("pay_freq", "scalar"),
        # dropped (lookup/rollup, not writable columns): tenant_status, property_id (=property
        # name lookup, not the tenancies FK), unit_reference
    }),
    "tenants": ("tblX4elTuu01gwBYh", {
        "fldxBKW7QnujSDWqA": ("name", "scalar"),
        "fldix9mkn151Yl2eH": ("surname", "scalar"),
        "fldAXzP9SGIHiAhrv": ("status", "scalar"),
        "fldeLsZYqbKS77S2V": ("current_unit_id", "link"),
        "fldraHUkWfqo4olLF": ("phone", "scalar"),
        "fldybEduFY3DWWTfT": ("email", "scalar"),
        "fldv7FKsqXYswyCFE": ("dob", "date"),
        "fldZbrk8Xw5Dcwxhi": ("pay_type", "scalar"),
        # dropped: tenancies (inverse-link array, read-only)
    }),
    "rental_units": ("tblM3mZCR5kiEdWMj", {
        "fld3nPlpdXSExxDuq": ("unit_number", "num"),
        "fldBvqysXBm9rIm0E": ("status", "scalar"),
        "fldUJNRGgzgyAwwjt": ("property_id", "link"),
        "fldsItq0vU3sHv7n9": ("unit_type", "scalar"),
        "fldQO09UAFRf07V7q": ("current_tenant_id", "link"),
        "fldxOnUDg49C2PNVW": ("current_tenancy_id", "link"),
        # dropped: name (formula/lookup — rental_units has no `name` column)
    }),
    "properties": ("tbl6f0OkAmTC2jbuG", {
        "fldy2t735TV5e1DIL": ("property", "scalar"),
        "fldKLF9xZ4YhzCswh": ("prop_type", "scalar"),
        "fldeXUMcC6O4AcvRG": ("beds", "num"),
        "fldxsjkiQ3RcV7y1j": ("market_value", "num"),
        "fldliPo3ClTAOomKG": ("mortgage_balance", "num"),
        "fldEUrWVhSp3NY8Hh": ("agent", "scalar"),
        "fldpM6c1zm29JxdLb": ("purchase_date", "date"),
        "fldUPO8q3dkY2YxDQ": ("notes", "scalar"),
        "fldjk13txQl6HVNyK": ("mortgage_cost_link", "link"),
        "fldBZKzQDV7UXwrI8": ("business_id", "link"),
        # dropped: units (inverse-link array); property_name_short is GENERATED in Supabase
    }),
    "property_valuations": ("tblZYsa0u1M17N7ZE", {
        "fldRBIx2kRFAVmH0k": ("title", "scalar"),
        "fldEEmN3R9fSsX9mr": ("property_id", "link"),
        "fldjuVUTvN7poUAgD": ("date", "date"),
        "fldMecW8pkzlyY7Gp": ("estimated_value", "num"),
        "fldu2CSv2DsCYDXmh": ("source", "scalar"),
        "fldQtbOpIQ2BR0yYz": ("status", "scalar"),
        "fldgFb0ICksUdb29u": ("confidence", "scalar"),
        "fldnldTHRVLBVrvOe": ("comparables", "scalar"),
        "fldu0WJbrGAehac4Q": ("methodology", "scalar"),
        "fld52DDH3BhY0vCra": ("previous_value", "num"),
        "fld8X5yIdz6oPG2jj": ("approved_by", "scalar"),
        "fldxUhWDTrpWEFGCK": ("approved_on", "date"),
    }),
    "businesses": ("tblpqkvWJJo8Uu25q", {
        "fldbbRqVxLxUdHwIR": ("name", "scalar"),
        "fldhXBnRrngCVsgSk": ("active", "bool"),
    }),
    "coa_categories": ("tbleWb8ioptnEwPR8", {
        "fldii4oUzSfmplihO": ("name", "scalar"),
    }),
    "coa_sub_categories": ("tblOTdRcPf8AgRz25", {
        "fldO4BTJhFv5EsN6i": ("name", "scalar"),
        # NOTE: coa_sub_categories.category_id (FK) is NOT in the shim map, so it is not
        # mirrored here — the shims never needed the parent-link field id. Existing rows
        # keep their category_id; a mirror won't repopulate it. Flagged in the build report.
    }),
    # ---- os/team/team-shim.js ----
    "team_members": ("tblco0p2OnlLQVAX7", {
        "fldh16yvEgBy8uLKQ": ("member", "collab"),          # -> member (name) + member_email
        "fldFyTZu3vu1a7X3a": ("preferred_name", "scalar"),
        "fld1DYEbtyVsO2GVP": ("full_legal_name", "scalar"),
        "fld6O2PpClGpTZd8N": ("role_id", "link"),
        "fldi8KmXyedB1ixrr": ("department_id", "link"),
        "fld2Wt9bHuIT9iia4": ("manager_id", "link"),
        "fldraub938ex3BqMU": ("work_email", "scalar"),
        "fldTZ0ReLsqpAHxE8": ("whatsapp", "scalar"),
        "fldekq1yBG4ZC2jKU": ("profile_photo", "json"),
        "fldWQldpgSxZRqUu5": ("job_title", "scalar"),
        "fldTOGTPw20khbtec": ("status", "scalar"),
        "fld9uw166E6TkGusD": ("start_date", "date"),
        "fld2YLfcPqSe6b60u": ("active", "bool"),
        "fldqqOLK8d934TLdL": ("contract_docs", "json"),
        "fld819Jpc8zHEUyVh": ("country", "scalar"),
        "fld2XkmSBs70NvXKn": ("working_days", "textarr"),
        "fldIwCBuf1B8KMbIp": ("weekly_capacity", "num"),
        "fldbvMos3oFMrb4W9": ("business_id", "link"),
        "fld3OV2XCYDAWwwbX": ("slack_handle", "scalar"),
        "fldXOpDiYpVnxyDyL": ("dob", "date"),
        # NOT mapped: flds7xoRFQhcRTnbB (name) — `name` is GENERATED from `member`; never write it
    }),
    "departments": ("tbloIBoYzlF3URiYK", {
        "fldDGaNynfawVs36F": ("name", "scalar"),
        "fldaXgNKrRhwoQ3t1": ("head_id", "link"),
    }),
    "roles": ("tblHiFrzekohQk2lt", {
        "fldR7jqnTLqFNdJ4Y": ("role", "scalar"),
        "fld45Tf2vWbbKVSEw": ("department_id", "link"),
    }),
    "sops": ("tblF3tSfEajPQJHoI", {
        "fldKuv5brBlD02B63": ("title", "scalar"),
        "fld6qkVkFgzN2XGbQ": ("sop_status", "scalar"),
        "fldiLbmDHr6ghPRNr": ("department_id", "link"),
        "fldxbWsXSSnWj6qBA": ("business_id", "link"),
        "fldm7Uew4thUsRwUe": ("team_member_id", "link"),
        "fldJms3VbxHmkaHol": ("is_trained", "bool"),        # Supabase col is boolean (shim said scalar)
        "fldileM23VJc0b8Kd": ("sop_video", "scalar"),
    }),
    "achievements": ("tblHtx8o3zt1Rd8fF", {
        "fldvux4XWfVhVZ87B": ("title_ai", "scalar"),        # write title_ai; `title` is GENERATED from it
        "fldntslZwKqS7jnkv": ("team_member_id", "link"),
        "fldUxbt7ZOB5Ig1yD": ("description", "scalar"),
        "fld0dfmYoaMQEbXrU": ("date", "date"),
        "fldUh6dqEh9PNc8gr": ("type", "scalar"),
        "fldlKhLHUYg1fPf7X": ("source", "scalar"),
        "fldPO8gtvCy9qUN4D": ("status", "scalar"),
        "fldaNdproX7gYya93": ("approval", "bool"),
        # NOT mapped: fld371pHn1EQYRDq0 (title) — GENERATED column, never write it
    }),
    # ---- os/systemisation/systemisation-shim.js ----
    "main_methods": ("tbl065D58MBEJhjlp", {
        "fldRphzaAUzBqconG": ("name", "scalar"),
        "fldWDxL9EyS1iaGlf": ("description", "scalar"),
        "fldi4uVOf2NgxiSKy": ("objstrat_ids", "linkArr"),
    }),
    "sys_workflows": ("tblLPoRHFBl0vqR24", {
        "fldsaS0jeoSRuJN28": ("name", "scalar"),
        "fld1cGXzKp8ab5nBr": ("description", "scalar"),
        "fldoN7pdUv4CIcKf2": ("fulfil_stage", "scalar"),
        "fldTYbvsvqD1CQmxd": ("department", "scalar"),
        "fldBHe23lba7DkLci": ("status", "scalar"),
        "fldOAAESotc8rNKyu": ("sort_order", "num"),
        "fldQZEvjCRYUaQdME": ("main_method_ids", "linkArr"),
        "fldQcQSnlSipSBhb4": ("business_ids", "linkArr"),
        "fldmRF1UDkbHtl1AG": ("skill_definition", "scalar"),
        "fldNtXnxGrpUivWxU": ("drive_url", "scalar"),
        "fldgXZCvwDKgTHGsH": ("drive_doc_url", "scalar"),
        "fldW4qoDv2mrTNvu7": ("sop_document", "scalar"),
    }),
    "workflow_steps": ("tblTadoyWXFHbmYxm", {
        "fldqKG4mVY16PTNmO": ("name", "scalar"),
        "fldlSSG0bV9VyhKEN": ("description", "scalar"),
        "fldmGLPupz0fZFfch": ("workflow_id", "link"),
        "fldPHutLN9Q2c2SzU": ("step_type", "scalar"),
        "fldyNojZsSjfF6lLI": ("sop_content", "scalar"),
        "fldZo6pPcn1lNvOay": ("sop_status", "scalar"),
        "fldOWS3MfMSVJyo0b": ("sort_order", "num"),
        "fldOisvuXul0r1XUD": ("skill_id", "scalar"),
    }),
}

# JSONB-blob tables. All stored id-keyed (returnFieldsByFieldId=true) to match the DB.
# objectives_strategy also derives filter columns.
JSONB = {
    "objectives_strategy": ("tblEBvFw8DonwxzGh", True),   # True = derive business/quarter/year columns
    "net_worth_by_month":  ("tblvtDXCBJCHu9hnK", False),
    "income_buckets":      ("tbldMPjXTu7ho5f0T", False),
    "personal_budgets":    ("tblm5ZxyoiLfaBAS4", False),
}

# Writable (real, non-generated) columns per table — from a live Supabase
# information_schema read. A mapped column not in this set is dropped with a warning,
# so a stale shim map can never produce a 400 on an unknown/generated column.
WRITABLE = {
    "meetings": {"name","date","status","attendees","ext_attendees","summary","action_points","tasks","recording","source"},
    "accounts": {"name","gbp","last_update","account_alias","business_id"},
    "costs": {"name","expected","due_day","frequency","pay_status_legacy","inactive",
              "due_date_next","sub_category_id","category_id","business_id","property_id"},
    "tenancies": {"ref","tenant_id","unit_id","pay_status","start_date","rent","due_day","pay_freq"},
    "tenants": {"name","surname","status","current_unit_id","phone","email","dob","pay_type"},
    "rental_units": {"unit_number","status","property_id","unit_type","current_tenant_id","current_tenancy_id"},
    "properties": {"property","prop_type","beds","market_value","mortgage_balance","agent",
                   "purchase_date","notes","mortgage_cost_link","business_id"},
    "property_valuations": {"title","property_id","date","estimated_value","source","status",
                            "confidence","comparables","methodology","previous_value","approved_by","approved_on"},
    "businesses": {"name","active"},
    "coa_categories": {"name"},
    "coa_sub_categories": {"name","category_id"},
    "team_members": {"member","member_email","preferred_name","full_legal_name","role_id",
                     "department_id","manager_id","work_email","whatsapp","profile_photo","job_title",
                     "status","start_date","active","contract_docs","country","working_days",
                     "weekly_capacity","business_id","slack_handle","dob"},
    "departments": {"name","head_id"},
    "roles": {"role","department_id"},
    "sops": {"title","sop_status","department_id","business_id","team_member_id","is_trained","sop_video"},
    "achievements": {"title_ai","team_member_id","description","date","type","source","status","approval"},
    "main_methods": {"name","description","objstrat_ids"},
    "sys_workflows": {"name","description","fulfil_stage","department","status","sort_order",
                      "main_method_ids","business_ids","skill_definition","drive_url","drive_doc_url","sop_document"},
    "workflow_steps": {"name","description","workflow_id","step_type","sop_content","sop_status","sort_order","skill_id"},
}

# FK link column -> referenced Supabase table. Used to guard link writes (only set a
# link if its target row exists in Supabase) — mirrors sync-transactions.py's fk().
# linkArr (jsonb) columns are NOT FKs and are never guarded.
FK_REF = {
    "business_id":"businesses", "category_id":"coa_categories", "sub_category_id":"coa_sub_categories",
    "property_id":"properties", "unit_id":"rental_units", "current_unit_id":"rental_units",
    "tenant_id":"tenants", "current_tenant_id":"tenants", "current_tenancy_id":"tenancies",
    "department_id":"departments", "role_id":"roles", "head_id":"team_members",
    "manager_id":"team_members", "team_member_id":"team_members", "workflow_id":"sys_workflows",
    "mortgage_cost_link":"costs",
}

# NOT-NULL boolean columns — coerce absent Airtable value to False (the DB default)
# rather than NULL, which would violate the constraint.
NOTNULL_BOOL = {("businesses","active"), ("team_members","active"),
                ("sops","is_trained"), ("achievements","approval")}

# Parent-before-child order (best-effort; a rental_units↔tenants↔tenancies cycle means
# one direction of links may be nulled on the very first --full load and filled next run).
ORDER = ["businesses","coa_categories","coa_sub_categories","departments","roles","team_members",
         "properties","rental_units","tenants","tenancies","property_valuations","accounts","costs",
         "sops","achievements","main_methods","sys_workflows","workflow_steps",
         "objectives_strategy","net_worth_by_month","income_buckets","personal_budgets"]


# ── coercion helpers ─────────────────────────────────────────────────────────────
def num(v):
    try: return float(v) if v not in (None, "") else None
    except (TypeError, ValueError): return None

def to_bool(v):
    # Handles real checkboxes (true/false) AND string-formula fields like sops.is_trained,
    # which is an Airtable formula returning "Completed"/"Not Completed" for a boolean column.
    if v is None or v == "": return None
    if isinstance(v, bool): return v
    if isinstance(v, (int, float)): return bool(v)
    s = str(v).strip().lower()
    if s in ("true","yes","1","checked","x","y","completed","done","trained"):  return True
    if s in ("false","no","0","","not completed","incomplete","untrained"):     return False
    return bool(v)

def first_id(v):
    """Airtable link field -> single record id string."""
    if isinstance(v, list):
        if not v: return None
        x = v[0]
        return x.get("id") if isinstance(x, dict) else x
    if isinstance(v, dict): return v.get("id")
    return v

def id_list(v):
    """Airtable link field -> list of record id strings (for jsonb linkArr)."""
    if v is None: return []
    if not isinstance(v, list): v = [v]
    return [(x.get("id") if isinstance(x, dict) else x) for x in v if x]


def build_columnar_row(table, rec, fmap, id_sets):
    """Turn one Airtable record into a Supabase row dict. Returns (row, dropped_cols)."""
    fields = rec.get("fields", {})
    writable = WRITABLE.get(table, set())
    row = {"id": rec["id"], "org_id": HOME_ORG}
    dropped = set()
    for fid, (col, kind) in fmap.items():
        if col not in writable and kind != "collab":
            dropped.add(col); continue
        raw = fields.get(fid)
        if kind == "collab":
            # collaborator {id,email,name}: name -> member column, email -> member_email
            name = email = None
            if isinstance(raw, dict): name, email = raw.get("name") or raw.get("email"), raw.get("email")
            elif isinstance(raw, str): name = raw
            row[col] = name
            if "member_email" in writable: row["member_email"] = email
            continue
        if raw is None or raw == "":
            # mirror emptiness with NULL, except NOT-NULL bool cols -> default False
            row[col] = False if (table, col) in NOTNULL_BOOL else None
            continue
        if kind == "num":         row[col] = num(raw)
        elif kind == "bool":      row[col] = to_bool(raw)
        elif kind == "link":
            v = first_id(raw)
            ref = FK_REF.get(col)
            if ref and id_sets is not None and v not in id_sets.get(ref, set()):
                v = None    # FK guard — don't point at a row that isn't in Supabase (yet)
            row[col] = v
        elif kind == "linkArr":   row[col] = id_list(raw)          # jsonb array of ids
        elif kind == "textarr":   row[col] = raw if isinstance(raw, list) else [raw]
        elif kind == "json":      row[col] = raw
        else:                     row[col] = raw                    # scalar / date / datetime
    return row, dropped


def build_jsonb_row(table, rec, derive):
    fields = rec.get("fields", {})
    row = {"id": rec["id"], "org_id": HOME_ORG, "fields": fields}
    if derive:   # objectives_strategy filter columns
        biz = first_id(fields.get(OS_F_BUSINESS))
        row["business_id"] = biz
        if OS_F_QUARTER in fields: row["quarter"] = fields[OS_F_QUARTER]
        if OS_F_YEAR in fields:    row["year"]    = fields[OS_F_YEAR]
        ct = rec.get("createdTime")
        if ct: row["created_time"] = ct
        # business_name is filled from the biz-id->name map at write time (needs Supabase read)
        row["_business_id_for_name"] = biz
    return row


# ── Airtable read ────────────────────────────────────────────────────────────────
def airtable_records(table_id, full, fields=None):
    """All records (full) or those modified in the last WIN days (incremental)."""
    out, offset = [], None
    formula = None if full else f"IS_AFTER(LAST_MODIFIED_TIME(), DATEADD(NOW(), -{WIN}, 'days'))"
    while True:
        q = [("returnFieldsByFieldId", "true"), ("pageSize", "100")]
        if formula: q.append(("filterByFormula", formula))
        if fields:
            for fid in fields: q.append(("fields[]", fid))
        if offset: q.append(("offset", offset))
        url = f"https://api.airtable.com/v0/{BASE}/{table_id}?" + urllib.parse.urlencode(q)
        req = urllib.request.Request(url, headers={"Authorization": f"Bearer {PAT}"})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                d = json.load(r)
        except urllib.error.HTTPError as e:
            raise RuntimeError(f"Airtable HTTP {e.code} — {e.read().decode()[:200]}")
        out += d["records"]
        offset = d.get("offset")
        if not offset: break
    return out


# ── Supabase REST ────────────────────────────────────────────────────────────────
def sb(method, path, body=None, prefer=None):
    h = {"apikey": KEY, "Authorization": f"Bearer {KEY}", "Content-Type": "application/json"}
    if prefer: h["Prefer"] = prefer
    req = urllib.request.Request(SB + path,
                                 data=(json.dumps(body).encode() if body is not None else None),
                                 method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=90) as x:
            return x.status, x.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()

def id_set(table):
    s, b = sb("GET", f"/rest/v1/{table}?select=id")
    return {row["id"] for row in json.loads(b)} if s == 200 else set()

def biz_name_map():
    s, b = sb("GET", "/rest/v1/businesses?select=id,name")
    return {r["id"]: r["name"] for r in json.loads(b)} if s == 200 else {}

def upsert(table, rows):
    """Chunked idempotent upsert on id; isolates a bad row so one failure can't drop a batch."""
    ok = bad = 0
    for i in range(0, len(rows), 200):
        chunk = rows[i:i+200]
        s, b = sb("POST", f"/rest/v1/{table}?on_conflict=id", chunk,
                  "resolution=merge-duplicates,return=minimal")
        if s < 300:
            ok += len(chunk); continue
        for row in chunk:
            s2, b2 = sb("POST", f"/rest/v1/{table}?on_conflict=id", [row],
                        "resolution=merge-duplicates,return=minimal")
            if s2 < 300: ok += 1
            else: bad += 1; print(f"    skip {row['id']}: {b2[:140]}")
    return ok, bad


# ── per-table runner ─────────────────────────────────────────────────────────────
def run_table(table, id_sets, biz_names):
    is_jsonb = table in JSONB
    if is_jsonb:
        table_id, derive = JSONB[table]
        fmap = None
    else:
        table_id, fmap = COLUMNAR[table]

    recs = airtable_records(table_id, ARGS.full, fields=(list(fmap.keys()) if fmap else None))
    read = len(recs)

    rows, dropped = [], set()
    for rec in recs:
        if is_jsonb:
            row = build_jsonb_row(table, rec, JSONB[table][1])
            if "_business_id_for_name" in row:
                bid = row.pop("_business_id_for_name")
                if biz_names is not None:
                    row["business_name"] = biz_names.get(bid)
            rows.append(row)
        else:
            row, drp = build_columnar_row(table, rec, fmap, id_sets)
            dropped |= drp
            rows.append(row)

    if dropped:
        print(f"  [{table}] dropped non-writable mapped column(s): {', '.join(sorted(dropped))}")

    if ARGS.dry_run:
        print(f"  [{table}] read {read} | WOULD upsert {len(rows)} (dry-run, no write)")
        return read, len(rows), 0

    if not rows:
        print(f"  [{table}] read 0 | nothing to upsert")
        return 0, 0, 0
    ok, bad = upsert(table, rows)
    print(f"  [{table}] read {read} | upserted {ok}{f' | {bad} skipped' if bad else ''}")
    return read, ok, bad


def main():
    mode = "FULL" if ARGS.full else "incremental"
    only = {t.strip() for t in ARGS.only.split(",") if t.strip()}
    tables = [t for t in ORDER if not only or t in only]

    print(f"Airtable → Supabase MIRROR — mode={mode}{' [DRY RUN]' if ARGS.dry_run else ''}"
          f"{'' if ARGS.full else f' (last {WIN} days)'}")
    print(f"Tables: {len(tables)}   org_id={HOME_ORG}\n")

    # FK-guard id-sets + business-name map (real runs only; dry-run reads nothing from Supabase)
    id_sets, biz_names = None, None
    if not ARGS.dry_run:
        ref_tables = sorted(set(FK_REF.values()))
        id_sets = {t: id_set(t) for t in ref_tables}
        biz_names = biz_name_map()

    tot_read = tot_up = tot_bad = 0
    failures = []
    for table in tables:
        try:
            r, u, b = run_table(table, id_sets, biz_names)
            tot_read += r; tot_up += u; tot_bad += b
        except Exception as e:   # per-table isolation — one bad table can't kill the run
            failures.append(table)
            print(f"  [{table}] FAILED: {e}")

    print(f"\nDONE — read {tot_read} | {'would upsert' if ARGS.dry_run else 'upserted'} {tot_up}"
          f"{f' | {tot_bad} skipped' if tot_bad else ''}"
          f"{f' | {len(failures)} table(s) FAILED: ' + ', '.join(failures) if failures else ''}")
    if failures and not ARGS.dry_run:
        sys.exit(1)


if __name__ == "__main__":
    main()
