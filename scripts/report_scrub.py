#!/usr/bin/env python3
"""Mask personal data out of routine reports before they enter a PUBLIC repo.

WHY THIS EXISTS (12 Aug 2026 — finding 20260812-daily-ops-115)
--------------------------------------------------------------
github.com/chaichoong/leadership-dashboard is public. The routines write a
markdown report into `monitoring/` every morning and queue-fixer commits it.
Those reports quote real Airtable rows, and an INBOUND SMS task is titled with
the sender's phone number, so `monitoring/task-sweep-2026-08-11.md` shipped a
tenant's mobile number to the open internet in two places.

On 12 Aug the same number appeared again and was masked BY HAND before the
commit. Hand-masking is not a control: it works exactly as long as somebody
remembers, and this is a 07:00 unattended job. This module is the control.

It is the second half of the 31 Jul 2026 leak fix. That one stopped the sweep
JSON (via `monitoring/.gitignore`, guarded by tests/never-commit-paths.test.js)
and left the markdown, which is committed on purpose and therefore cannot be
solved by ignoring it. So the markdown gets scrubbed on the way in instead.

WHAT IT MASKS
-------------
  phone     +447700900747        -> +4477XXXXX747     (UK, national or +44)
  email     jane@acme-lets.co.uk -> j***@***.co.uk
  postcode  CB23 6DL             -> CB23 XXX          (inward code removed)
  NI number AB123456C            -> XXXXXXXXX         (National Insurance)
  reference account 900000291    -> account XXXXXX291 (after a keyword only)

Shape is preserved on purpose. A report is an audit trail: "an SMS from a
+44 mobile ending 747" is still useful to Kevin, who can look the record up in
Airtable, while the digits that identify a person do not leave the machine.

THE CONTROL ON THE CONTROL
--------------------------
A regex that matches nothing reads as "no PII found" for ever — the same silent
pass that let the recon accuracy card measure 100 rows and call it 259. So
`selftest()` runs known-bad fixtures through the real patterns and returns the
failures. collect-routine-reports.py calls it BEFORE copying anything and
refuses to run if any fixture survives unmasked.

Never widen ALLOWED_EMAIL_DOMAINS to a domain that belongs to a third party.
The list is Kevin's own identities, which are already public in this repo.
"""

import os
import re

# Kevin's own, already-public identities. Masking these would only make the
# reports harder to read; they are not somebody else's personal data.
ALLOWED_EMAIL_DOMAINS = (
    "operationsdirector.co.uk",
    "runpreneur.org.uk",
    "kevinbrittain.workers.dev",
    "example.com",
    "example.org",
    "example.net",
)
ALLOWED_EMAILS = ("kevinbrittain@gmail.com",)

# A candidate is a +44 or 0-led run of digits/spaces/hyphens. The digit COUNT
# decides whether it is really a phone number, which is what keeps dates
# (2026-08-12), record counts and money out of it. The lookarounds stop the tail
# of a date or a decimal being read as the start of a number.
#
# Two details that were bugs in the first draft, both caught by running this
# over the real reports before shipping it:
#   * a LITERAL space, never \s. With \s the run crossed a newline and
#     "...totalling 00\n2026-08-05" parsed as an eleven-digit phone number.
#   * the match must END on a digit. Ending on the trailing space swallowed it,
#     so the masked text ran into the next word.
#   * a BARE 44-led number with no plus and no leading zero. GoHighLevel and the
#     SMS bridge write the sender as "447700900077", and neither the "+44" branch
#     nor the "0" branch matches that shape. Found 26 Aug 2026 while collecting
#     monitoring/task-sweep-2026-08-26.md: two tenant mobiles were sitting in the
#     task titles, reported as "masked 3 phone" because OTHER numbers on the page
#     did match. A partial mask reads exactly like a complete one.
# The trailing lookahead is `(?![\d/\-]|\.\d)`, NOT `(?![\d/.\-])`.
#
# Blocking on a bare "." blocked a full stop, so a number at the END OF A
# SENTENCE could never be masked (finding 20260821-task-hygiene-sweep-286, found
# while testing the fix for it). "+447700900907." sailed through every sweep,
# and monitoring/task-sweep-2026-08-23.md carried a real one into this PUBLIC
# repo for five days.
#
# What the lookahead is actually FOR is decimals and dates — "1.0", "2026-08-05"
# — so it only needs to block a dot FOLLOWED BY A DIGIT. A dot followed by a
# space, a newline or end-of-text is punctuation, and the number before it is a
# phone number.
_PHONE_CANDIDATE = re.compile(
    r"(?<![\d/.\-])(\+ ?44[\d \-()]{7,15}\d|44\d{9,11}|0\d[\d \-]{6,12}\d)(?![\d/\-]|\.\d)"
)

_EMAIL = re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}")

# UK postcode. Uppercase only and bounded by non-alphanumerics, so it cannot
# eat part of a constant or an Airtable record id.
_POSTCODE = re.compile(
    r"(?<![A-Za-z0-9])([A-Z]{1,2}\d[A-Z\d]?)\s?(\d[A-Z]{2})(?![A-Za-z0-9])"
)


def _mask_phone(match):
    raw = match.group(0)
    digits = re.sub(r"\D", "", raw)
    # 10-13 digits is a UK number with or without the country code. Anything
    # else is a reference, an account number or a run of figures — left alone,
    # because a scrubber that mangles ordinary numbers gets switched off.
    if not (10 <= len(digits) <= 13):
        return raw
    # A bare "447..." is a +44 number written without the plus, not a 0-led one.
    bare_intl = not raw.lstrip().startswith("0") and digits.startswith("44")
    prefix = "+44" if (raw.lstrip().startswith("+") or bare_intl) else "0"
    tail = digits[2:] if prefix == "+44" else digits[1:]
    if len(tail) < 6:
        return raw
    return "%s%sX%s%s" % (prefix, tail[:2], "X" * (len(tail) - 6), tail[-3:])


def _mask_email(match):
    addr = match.group(0)
    lower = addr.lower()
    if lower in ALLOWED_EMAILS:
        return addr
    domain = lower.rsplit("@", 1)[-1]
    if any(domain == d or domain.endswith("." + d) for d in ALLOWED_EMAIL_DOMAINS):
        return addr
    parts = domain.split(".")
    tld = ".".join(parts[-2:]) if parts[-1] in ("uk", "au", "nz") else parts[-1]
    return "%s***@***.%s" % (addr[0], tld)


def _mask_postcode(match):
    return "%s XXX" % match.group(1)


# ─── NI NUMBERS AND ACCOUNT REFERENCES (21 Sep 2026) ──────────────────
#
# The reports quote task titles and letters, and a debt or tax letter is
# titled with its reference. By 21 Sep 2026 the tracked reports carried a
# family member's National Insurance number, a Unique Taxpayer Reference,
# council tax account and summons numbers, a court claim number, a mortgage
# account and several debt-collector references, none of which the phone,
# email or postcode rules could see.
#
# An NI number has a fixed shape, so it gets a shape rule. Its prefix letters
# follow HMRC's allocation rules (no D, F, I, Q, U or V first; no D, F, I, O,
# Q, U or V second), which keeps ordinary codes out of it.
_NINO = re.compile(
    r"(?<![A-Za-z0-9])[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z]"
    r" ?\d{2} ?\d{2} ?\d{2} ?[A-D](?![A-Za-z0-9])"
)


def _mask_nino(match):
    return "XXXXXXXXX"


# An account reference has NO fixed shape: nine plain digits, three letters and
# a hyphen before seven digits, a short letter-digit mix, and two digit groups
# split by a space are all real shapes seen in the reports. What they share is
# the word in front of them, so this rule only fires straight after a keyword
# ("account", "ref", "case", "claim", "summons", "UTR" ...), and only on a token
# of five or more characters holding three or more digits in a row. That keeps
# years, counts, mandate numbers ("MANDATE NO 0207"), Airtable ids and dates out.
# Like a phone number, the last three characters survive, so the report still
# says WHICH reference without giving it away.
#
# A reference with no keyword in front ("Council Tax - 10000000078") is not
# caught. That is the price of not mangling ordinary numbers; a scrubber that
# eats every figure gets switched off.
_REF_KEYWORD = (
    r"(?:account|acct|a/c|mortgage|policy|mandate|agreement|loan|customer|"
    r"client|case|claim|summons|title|utr|ref(?:erence)?)"
    r"(?:[ \t]+(?:no\.?|number|ref(?:erence)?))?"
)
_ACCOUNT_REF = re.compile(
    r"(?i)(?<![A-Za-z0-9])(" + _REF_KEYWORD + r")"
    r"((?:[ \t]*[:#][ \t]*|[ \t]+))"
    r"(?!(?:rec|tbl|fld|app|viw|sel|usr|wfl)[A-Za-z0-9]{14}(?![A-Za-z0-9]))"
    r"(?!\d{4}-\d{2}-\d{2})"
    r"(?=[A-Za-z0-9\-]*\d{3})"
    r"(\d{3,}(?: \d{3,})+|[A-Za-z0-9][A-Za-z0-9\-]{3,30}[A-Za-z0-9])"
    r"(?![A-Za-z0-9\-])"
)


def _mask_account_ref(match):
    keyword, sep, ref = match.group(1), match.group(2), match.group(3)
    keep = 3
    out = []
    for ch in reversed(ref):
        if ch.isalnum():
            out.append(ch if keep > 0 else "X")
            keep -= 1
        else:
            out.append(ch)
    return keyword + sep + "".join(reversed(out))


# ─── NAME ROSTER (finding 20260821-task-hygiene-sweep-286) ───────────
#
# A tenant and one of Kevin's family members were named in reports committed to
# this PUBLIC repository. Phone, email and postcode all have a SHAPE a regex can
# find; a name does not. The only way to mask one reliably is to know it in
# advance, so the names come from a roster.
#
# THE ROSTER LIVES OUTSIDE THE REPO on purpose (~/.config/od/redact-names.txt,
# override with $OD_REDACT_NAMES). Committing a list of the exact people to hide
# would publish the very thing it exists to protect.
#
# Missing roster returns [] and masks nothing. That is deliberate: a scrubber
# that refuses to run leaves the raw report in place, which is worse. Callers
# that need the guarantee check `load_roster()` themselves.

# Kevin's own name is deliberately NOT maskable: he is the author of this repo
# and appears in every commit, so masking it would only make reports unreadable
# without protecting anybody.
ALLOWED_NAMES = ("kevin brittain", "kevin", "brittain")

DEFAULT_ROSTER = os.path.join(
    os.path.expanduser("~"), ".config", "od", "redact-names.txt"
)


def roster_path():
    return os.environ.get("OD_REDACT_NAMES", DEFAULT_ROSTER)


def load_roster(path=None):
    """The names to mask. A missing file returns []; callers check."""
    path = path or roster_path()
    if not os.path.isfile(path):
        return []
    names = []
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            name = line.strip()
            if not name or name.startswith("#"):
                continue
            if name.lower() in ALLOWED_NAMES:
                continue
            # A single word is too collision-prone to mask globally ("Martin",
            # "May", "Price" are all ordinary report words), so the roster only
            # ever matches a full name.
            if len(name.split()) < 2:
                continue
            names.append(name)
    return names


def compile_names(names):
    """Longest name first, so 'Jane Q Tenant' wins over 'Jane Tenant'."""
    if not names:
        return None
    ordered = sorted(set(names), key=len, reverse=True)
    # Escape each word and rejoin on \s+, so "Jane  Tenant" and a name split
    # across a line wrap both match. Do NOT rely on re.escape() escaping the
    # space itself: it did on Python 3.6 and does not on 3.7+.
    joined = "|".join(
        r"\s+".join(re.escape(word) for word in n.split()) for n in ordered
    )
    return re.compile(r"(?<![\w'])(%s)(?![\w'])" % joined, re.IGNORECASE)


_ROSTER_CACHE = {}


def _name_pattern():
    path = roster_path()
    if path not in _ROSTER_CACHE:
        _ROSTER_CACHE[path] = compile_names(load_roster(path))
    return _ROSTER_CACHE[path]


def _mask_name(match):
    return "[name redacted]"


RULES = (
    ("phone", _PHONE_CANDIDATE, _mask_phone),
    ("email", _EMAIL, _mask_email),
    ("postcode", _POSTCODE, _mask_postcode),
    # NI before references, so "ref AB123456C" is masked whole, not to its tail.
    ("nino", _NINO, _mask_nino),
    ("account_ref", _ACCOUNT_REF, _mask_account_ref),
)


def scrub(text, names=None):
    """Return (scrubbed_text, hits) where hits is [(kind, original), ...].

    `names` overrides the roster (used by the tests). Passing None loads the
    roster from disk; passing [] masks no names at all.
    """
    hits = []

    def wrap(kind, fn):
        def replace(match):
            out = fn(match)
            if out != match.group(0):
                hits.append((kind, match.group(0)))
            return out

        return replace

    for kind, pattern, fn in RULES:
        text = pattern.sub(wrap(kind, fn), text)

    # Names last. The shaped rules above have already replaced phone numbers and
    # emails, so a name inside an email local-part is gone before we get here
    # and cannot be double-masked into nonsense.
    pattern = compile_names(names) if names is not None else _name_pattern()
    if pattern is not None:
        text = pattern.sub(wrap("name", _mask_name), text)
    return text, hits


# Known-bad inputs, each with the substring that must NOT survive. If a pattern
# is broken or deleted, one of these comes back unmasked and every caller stops.
SELFTEST_CASES = (
    ("SMS reply from +447700900747 about a tap", "7700900747"),
    ("SMS reply from +44 7700 900747 about a tap", "900747"),
    ("Called 07700900747 twice", "7700900747"),
    # GoHighLevel / SMS-bridge shape: no plus, no leading zero.
    ("SMS reply from 447700900077 - second thread", "7700900077"),
    ("MAINTENANCE: SMS from 447700900747 - maintenance reply", "7700900747"),
    ("Landline 01223 456789 rang out", "456789"),
    ("Chase accounts@some-letting-agent.co.uk for the statement", "some-letting-agent"),
    ("Tenant at CB23 6DL reported damp", "6DL"),
    # END OF SENTENCE. The old trailing lookahead blocked on a bare ".", so this
    # shape survived every sweep and reached the public repo.
    ("INBOUND: SMS reply from +447700900907.", "7700900907"),
    ("Ring 07700900747. Then log it.", "7700900747"),
    # NI numbers, with and without the spaces HMRC prints them with.
    ("HMRC statement for Mrs A Example, ref AB123456C, overdue", "123456"),
    ("NI number AB 12 34 56 C on the form", "12 34 56"),
    # Account references, only ever after a keyword.
    ("Council Tax summons - account 900000291 - Summons 100078", "900000291"),
    ("Council Tax summons - account 900000291 - Summons 100078", "100078"),
    ("s.9A check, case ABC-1000425, UTR 1000000560", "1000425"),
    ("s.9A check, case ABC-1000425, UTR 1000000560", "1000000560"),
    ("Court order, claim X00AB745, costs due", "X00AB7"),
    ("LCS ref 40000151, client ref A40000345", "40000151"),
    ("LCS ref 40000151, client ref A40000345", "A40000"),
    ("Council Tax Property Reference : 300000820 set up", "300000820"),
    ("HMRC penalty, ref 70000 30733, same year", "70000 30"),
    ("Arrangement on mortgage 70000083, 22 Example St", "70000083"),
)

# Inputs that must survive UNTOUCHED. A scrubber that mangles ordinary report
# text is one somebody turns off, which is the same as not having one.
SELFTEST_UNTOUCHED = (
    "8,690 transactions on 2026-08-12 totalling 1742.60",
    "Base appnqjDpqDniH3IRl table tblqB8b22hKBL4PF1 record recSvXxaEz57i7YQK",
    "Email kevinbrittain@gmail.com and kevin@operationsdirector.co.uk",
    "Version 1.6 vs 1.0, 100 rows of 259, HTTP 200 OK",
    # Real false positive from monitoring/ceo-brief-cron-findings.md: a table
    # cell ending "00" followed by a newline and the next row's date.
    "| invocations | 00\n2026-08-05 | 1 |",
    # Words that trigger the reference rule, followed by things that are NOT
    # references: an Airtable id, a date, a year, a short mandate number, a
    # company number with no keyword, a hyphenated file name, a git sha in
    # backticks, and prose.
    "Reference: recSvXxaEz57i7YQK, case recQxOwx7swgS1Vd4",
    "account 2026-08-12 review, policy 2026, MANDATE NO 0207",
    "Example Estates Ltd, company 10000161; reference-map.json rolled",
    "the reference is Example Estates Ltd, ref `0efc866b`",
    "Invoice INV-0549 and finding 20260821-task-hygiene-sweep-286",
    "loan of 2000 over 60 months, 100 cases, account for 12 days",
    # Already masked: a second pass must not change it.
    "account XXXXXX291 and ref XXX-XXXX425",
)


SELFTEST_ROSTER = ("Jane Tenantington", "Aa Bb Cc")

SELFTEST_NAME_CASES = (
    ("Chase Jane Tenantington for August rent", "Tenantington"),
    ("chase JANE  TENANTINGTON for august rent", "TENANTINGTON"),
    ("Tax liability 2023/24 - Aa Bb Cc, 189 days late", "Bb Cc"),
)

# Must survive: a single roster word on its own is ordinary report text, and a
# longer word that merely CONTAINS a roster name is a different word.
SELFTEST_NAME_UNTOUCHED = (
    "Jane closed 4 tasks",
    "Tenantingtonshire Council sent a bill",
)


def selftest():
    """Return a list of failure strings. Empty list means the patterns work."""
    failures = []
    for text, must_go in SELFTEST_CASES:
        out, hits = scrub(text, names=SELFTEST_ROSTER)
        if must_go in out:
            failures.append("did not mask %r in %r (got %r)" % (must_go, text, out))
        elif not hits:
            failures.append("masked %r but reported no hit" % text)
    for text in SELFTEST_UNTOUCHED:
        out, hits = scrub(text, names=SELFTEST_ROSTER)
        if out != text:
            failures.append("false positive: %r became %r" % (text, out))

    for text, must_go in SELFTEST_NAME_CASES:
        out, hits = scrub(text, names=SELFTEST_ROSTER)
        if must_go in out:
            failures.append("did not mask name %r in %r (got %r)"
                            % (must_go, text, out))
        elif not any(kind == "name" for kind, _ in hits):
            failures.append("masked %r but reported no name hit" % text)
    for text in SELFTEST_NAME_UNTOUCHED:
        out, _ = scrub(text, names=SELFTEST_ROSTER)
        if out != text:
            failures.append("name false positive: %r became %r" % (text, out))

    return failures


def roster_problems(path=None):
    """THE CONTROL ON THE ROSTER, kept separate from selftest() on purpose.

    An absent or empty roster masks no names and reports a clean sweep, which is
    indistinguishable from a report that genuinely names nobody. Only one of
    those is safe in a public repo.

    It is NOT folded into selftest() because the two answer different questions.
    selftest() asks "do the patterns still work", which must be true on any
    machine and in CI. This asks "is this machine configured to publish", which
    is only meaningful where reports are actually collected. Merging them would
    fail the suite on a clean clone for a reason unrelated to the code under
    test, which is the kind of red that teaches people to bypass a gate.
    """
    path = path or roster_path()
    if not load_roster(path):
        return [
            "name roster is missing or empty at %s - run "
            "scripts/refresh-redact-names.py (nothing can be published until "
            "the roster loads)" % path
        ]
    return []


if __name__ == "__main__":
    import sys

    problems = selftest() + roster_problems()
    if problems:
        for p in problems:
            print("FAIL: %s" % p)
        sys.exit(1)
    if len(sys.argv) > 1:
        for path in sys.argv[1:]:
            with open(path) as fh:
                original = fh.read()
            cleaned, hits = scrub(original)
            if hits:
                with open(path, "w") as fh:
                    fh.write(cleaned)
                print("MASKED %d item(s) in %s: %s"
                      % (len(hits), path,
                         ", ".join(sorted({k for k, _ in hits}))))
            else:
                print("clean %s" % path)
    else:
        print("selftest OK (%d cases)"
              % (len(SELFTEST_CASES) + len(SELFTEST_UNTOUCHED)))
