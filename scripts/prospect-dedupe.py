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

    python3 scripts/prospect-dedupe.py keys "Cornerstone Supplies Ltd (t/a Abbeydale Direct)"
        -> cornerstone supplies abbeydale direct
           cornerstone supplies
           abbeydale direct
        A record matches if ANY of its keys is already in the set.

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

# A trading-name marker. "Cornerstone Supplies Limited (Abbeydale Direct)" and
# "Cornerstone Supplies Limited (t/a Abbeydale Direct)" are the SAME employer,
# but the 't/a' survived normalisation as the token 'ta' and split the key, so
# both were queued and mail@abbeydale-direct.co.uk was lined up to be cold-
# emailed twice (recbZXMmAMOo6Mv07 3 Aug, rec9p6crluEJaTSpa 10 Aug).
TRADING_AS = re.compile(
    r"\b(?:t\s*/\s*a|t\.?\s*a\.?|trading\s+as|formerly(?:\s+known\s+as)?|"
    r"aka|also\s+known\s+as|dba)\b",
    re.IGNORECASE,
)

PARENTHETICAL = re.compile(r"[(\[{][^)\]}]*[)\]}]")


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

    Trading-name markers ('t/a', 'trading as', 'aka', ...) and the brackets round
    a trading name are removed BEFORE step 3, so "(Abbeydale Direct)" and
    "(t/a Abbeydale Direct)" collapse to the same key. Punctuation stripping
    alone left the marker behind as the token 'ta' and split them.

    This returns ONE key — the whole name including any trading name. Use
    company_keys() to get the aliases a record should also be indexed under.
    """
    if not name:
        return ""
    text = str(name).lower().replace("&", " and ")
    text = TRADING_AS.sub(" ", text)
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


def company_keys(name):
    """Every key one company name should be indexed under, best first.

    A record is a duplicate if ANY of its keys matches any stored key. One name
    can legitimately be written three ways, and each is what the next source
    hands you:

        "Cornerstone Supplies Limited (t/a Abbeydale Direct)"
          -> cornerstone supplies abbeydale direct   (whole name)
          -> cornerstone supplies                    (registered name alone)
          -> abbeydale direct                        (trading name alone)

    Indexing only the whole name is why 'Abbey Antiques & Furnishings Ltd (The
    Abbey Group)' did not match an Indeed employer string of 'The Abbey Group'.

    Deliberately NOT split on: a company with no bracket and no marker. Splitting
    on a bare word would merge "Smith Group" into "Smith", and losing a real
    prospect is worse than the duplicate it prevents.
    """
    if not name:
        return []
    raw = str(name)
    keys = [company_key(raw)]

    # Everything before the first bracket or trading-as marker: the registered
    # name on its own.
    stem = PARENTHETICAL.split(raw)[0] if PARENTHETICAL.search(raw) else raw
    stem = TRADING_AS.split(stem)[0]
    keys.append(company_key(stem))

    # Each bracketed or post-marker segment: the trading name on its own.
    for inner in re.findall(r"[(\[{]([^)\]}]*)[)\]}]", raw):
        keys.append(company_key(TRADING_AS.sub(" ", inner)))
    parts = TRADING_AS.split(PARENTHETICAL.sub(" ", raw))
    for part in parts[1:]:
        keys.append(company_key(part))

    seen, out = set(), []
    for k in keys:
        # A single-token alias is too blunt to dedupe on ("Smith" would swallow
        # every Smith), so it is dropped rather than indexed.
        if not k or k in seen or len(k.split()) < 2:
            continue
        seen.add(k)
        out.append(k)
    # If the whole name is itself one token, keep it — there is nothing broader
    # to confuse it with.
    if not out and keys and keys[0]:
        out.append(keys[0])
    return out


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
        # Every alias, not just the whole name. A record found under any of its
        # keys is the same employer.
        for key in company_keys(f.get("Company")):
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
    elif cmd == "keys":
        for k in company_keys(" ".join(sys.argv[2:])):
            print(k)
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
