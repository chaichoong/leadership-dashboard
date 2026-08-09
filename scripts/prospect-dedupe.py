#!/usr/bin/env python3
"""The prospect dedupe key, as CODE rather than as prose in a SKILL.md.

WHY THIS FILE EXISTS
--------------------
Step 1 of .claude/skills/prospect-daily/SKILL.md told the agent to build "normalised
company names (lowercased, with Ltd/Limited suffixes stripped)". Prose cannot be
tested and it drifted twice in two days:

  8 Aug 2026 — "Smith & Sons Ltd" and "Smith and Sons Limited" produced different
               keys, so the same company was queued twice. Companies House numbers
               were only compared against the `Companies House No` field, while 36
               records carried the number solely in Notes.
  9 Aug 2026 — "Q.E.D. Industrial Controls" and "QED Industrial Controls" produced
               different keys, because stripping punctuation left three separate
               one-letter tokens.

Neither is a hard failure. A duplicate prospect looks exactly like a new one, and
the cost lands on the recipient: the same founder gets cold-emailed twice.

So the rule lives here, once, with tests/prospect-dedupe.test.js on top of it. The
skill calls this script instead of re-deriving the rule from a paragraph.

USAGE
-----
    python3 scripts/prospect-dedupe.py key "Q.E.D. Industrial Controls Ltd"
        -> qed industrial controls

    python3 scripts/prospect-dedupe.py ch "...free text..."
        -> one Companies House number per line

    python3 scripts/prospect-dedupe.py build
        -> the whole dedupe set as JSON, read live from Airtable:
           {companyKeys, emails, linkedin, chNumbers, suppressed}

Keep the RAW company string on every record. The key format has now changed twice,
and a stored key that cannot be re-derived from the source is a key that has to be
migrated best-effort — the same trap the reconciliation knowledge base fell into.
"""

import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

BASE_ID = "appnqjDpqDniH3IRl"
PROSPECTS = "tbljHVGJoKJf8acy3"
API_BASE = os.environ.get("AIRTABLE_API_BASE", "https://api.airtable.com").rstrip("/")

# Legal-form suffixes and joiners only. Deliberately NOT 'group', 'holdings' or
# 'services': "Smith Group" and "Smith Holdings" are usually two real companies,
# and a dedupe key that merges them loses a prospect silently, which is worse than
# the duplicate it prevents.
STOPWORDS = {
    "ltd", "limited", "plc", "llp", "llc", "cic", "cio", "inc", "incorporated",
    "company", "co", "uk", "the", "and",
}

# UK company numbers are 8 characters: 8 digits (England & Wales) or a 2-letter
# prefix plus 6 digits (SC, NI, OC, SO, NC, ...).
CH_PATTERN = re.compile(r"\b(?:[A-Z]{2}\d{6}|\d{8})\b", re.IGNORECASE)


def company_key(name):
    """Normalised company name for dedupe comparison. Both sides of every
    comparison must go through this function — a key is only meaningful against
    another key built the same way.

    The order of the steps matters:
      1. lowercase
      2. '&' -> ' and '            so "Smith & Sons" == "Smith and Sons"
      3. non-alphanumerics -> space
      4. drop stopwords (incl. 'and')  so both spellings collapse identically
      5. join consecutive single-character tokens   "q e d" -> "qed"

    Step 5 must run AFTER step 4, or "J & B Plumbing" keeps an 'and' wedged
    between its initials and never matches "JB Plumbing".
    """
    if not name:
        return ""
    text = str(name).lower().replace("&", " and ")
    text = re.sub(r"[^a-z0-9]+", " ", text)
    tokens = [t for t in text.split() if t and t not in STOPWORDS]

    joined, run = [], []
    for token in tokens:
        if len(token) == 1:
            run.append(token)
            continue
        if run:
            joined.append("".join(run))
            run = []
        joined.append(token)
    if run:
        joined.append("".join(run))
    return " ".join(joined)


def ch_numbers(text):
    """Every Companies House number in a blob of free text, upper-cased.

    The `Companies House No` field is not trustworthy on its own: on 8 Aug 2026,
    36 records carried the number only in Notes. Until every record populates the
    field, the dedupe set must be built from BOTH.
    """
    if not text:
        return []
    seen, out = set(), []
    for match in CH_PATTERN.findall(str(text)):
        value = match.upper()
        if value not in seen:
            seen.add(value)
            out.append(value)
    return out


def linkedin_key(url):
    """Lowercased path only — the same profile arrives with and without a query
    string, a trailing slash, www., or a locale subdomain."""
    if not url:
        return ""
    path = urllib.parse.urlparse(str(url).strip().lower()).path
    return path.rstrip("/")


def fetch_all(pat, table, fields=None):
    records, offset = [], None
    while True:
        qs = urllib.parse.urlencode({"pageSize": "100"})
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
            raise SystemExit(f"FATAL: HTTP {e.code} reading {table}: {detail}")
        records += body.get("records", [])
        offset = body.get("offset")
        if not offset:
            return records


def build(pat):
    fields = ["Company", "Contact Email", "LinkedIn URL", "Companies House No",
              "Notes", "Status"]
    records = fetch_all(pat, PROSPECTS, fields)
    out = {"companyKeys": {}, "emails": [], "linkedin": [], "chNumbers": {},
           "suppressed": {"emails": [], "linkedin": []}, "recordCount": len(records)}
    for rec in records:
        f = rec["fields"]
        suppressed = f.get("Status") == "Suppressed"
        key = company_key(f.get("Company"))
        if key:
            out["companyKeys"].setdefault(key, []).append(rec["id"])
        email = (f.get("Contact Email") or "").strip().lower()
        if email:
            out["emails"].append(email)
            if suppressed:
                out["suppressed"]["emails"].append(email)
        li = linkedin_key(f.get("LinkedIn URL"))
        if li:
            out["linkedin"].append(li)
            if suppressed:
                out["suppressed"]["linkedin"].append(li)
        # Field AND Notes. Either alone under-counts.
        for num in ch_numbers(f.get("Companies House No")) + ch_numbers(f.get("Notes")):
            out["chNumbers"].setdefault(num, []).append(rec["id"])
    # A dedupe set built from zero records is indistinguishable from a broken read,
    # and it would wave every duplicate through. Fail loudly instead.
    if not records:
        raise SystemExit("FATAL: Prospects table returned 0 records — dedupe set would "
                         "let everything through. Check the PAT and table id.")
    return out


def main():
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    cmd = sys.argv[1]
    if cmd == "key":
        print(company_key(" ".join(sys.argv[2:])))
    elif cmd == "ch":
        for n in ch_numbers(" ".join(sys.argv[2:])):
            print(n)
    elif cmd == "build":
        path = os.path.expanduser("~/.config/od/airtable_pat")
        try:
            with open(path) as fh:
                pat = fh.read().strip()
        except OSError:
            raise SystemExit(f"FATAL: cannot read Airtable PAT at {path}")
        print(json.dumps(build(pat), indent=2))
    else:
        raise SystemExit(f"unknown command '{cmd}'\n{__doc__}")


if __name__ == "__main__":
    main()
