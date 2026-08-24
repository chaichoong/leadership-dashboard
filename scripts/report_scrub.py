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
  phone     +447538631747        -> +4475XXXXX747     (UK, national or +44)
  email     jane@acme-lets.co.uk -> j***@***.co.uk
  postcode  CB23 6DL             -> CB23 XXX          (inward code removed)
  name      a rostered person    -> [name redacted]

THE NAME RULE (24 Aug 2026 - finding 20260821-task-hygiene-sweep-286)
---------------------------------------------------------------------
Phone, email and postcode all have a SHAPE, so a regex can find them in text
nobody has read. A person's name does not. Four tracked task-sweep reports
named an individual tenant against a rent-arrears task, and one named a family
member against a 2023/24 tax liability and the debt collector chasing it. The
working tree was redacted BY HAND on 21 Aug, which is the same non-control the
phone masking replaced: it lasts exactly as long as somebody is watching a
07:00 unattended job.

So names are masked from a roster rather than guessed. The roster is a plain
list of names, one per line, at ~/.config/od/redact-names.txt (override with
$OD_REDACT_NAMES). It lives OUTSIDE the repo on purpose: the repo is public, so
a checked-in list of the people we must not name would leak exactly the names
it protects. scripts/refresh-redact-names.py rebuilds it from Airtable, so a
new tenant is covered the morning after they are added, not whenever somebody
remembers.

An ABSENT or EMPTY roster is a FAILURE, never a quiet pass. `selftest()`
reports it and collect-routine-reports.py refuses to copy anything into the
public repo, because "no names configured" and "no names present" read
identically in the output and only one of them is safe.

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
#   * the trailing lookahead must not reject a SENTENCE-ENDING full stop.
#     "(?![\d/.\-])" did, so "+447700907077." at the end of a sentence matched
#     nothing at all — the regex could only end on a digit, and the only digit
#     available was the one before the stop. A raw mobile number reached the
#     public repo in monitoring/task-sweep-2026-08-23.md that way, and the
#     scrubber reported the file clean. The stop is only ambiguous when it is a
#     DECIMAL point, i.e. followed by a digit, so that is what is excluded now.
_PHONE_CANDIDATE = re.compile(
    r"(?<![\d/.\-])(\+ ?44[\d \-()]{7,15}\d|0\d[\d \-]{6,12}\d)(?![\d/\-]|\.\d)"
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
    prefix = "+44" if raw.lstrip().startswith("+") else "0"
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


# ─── NAME ROSTER ─────────────────────────────────────────────────────
#
# Kevin's own name is deliberately NOT maskable: it is the author of this repo
# and appears in every commit, so masking it would only make reports unreadable
# without protecting anyone.
ALLOWED_NAMES = ("kevin brittain", "kevin", "brittain")

DEFAULT_ROSTER = os.path.join(
    os.path.expanduser("~"), ".config", "od", "redact-names.txt"
)


def roster_path():
    return os.environ.get("OD_REDACT_NAMES", DEFAULT_ROSTER)


def load_roster(path=None):
    """Return the list of names to mask. Missing file returns []; callers check."""
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
            # "May", "Price" all appear as ordinary report words), so the roster
            # only ever matches a full name.
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
    # across a line wrap still match. Do NOT rely on re.escape() escaping the
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
)


def scrub(text, names=None):
    """Return (scrubbed_text, hits) where hits is [(kind, original), ...]."""
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

    # Names come from a roster, so the pattern is built at call time rather than
    # living in RULES. `names` is for the selftest and for callers that already
    # hold a roster; everything else reads the configured file.
    pattern = compile_names(names) if names is not None else _name_pattern()
    if pattern is not None:
        text = pattern.sub(wrap("name", _mask_name), text)

    return text, hits


# Known-bad inputs, each with the substring that must NOT survive. If a pattern
# is broken or deleted, one of these comes back unmasked and every caller stops.
SELFTEST_CASES = (
    ("SMS reply from +447538631747 about a tap", "7538631747"),
    ("SMS reply from +44 7538 631747 about a tap", "631747"),
    ("Called 07538631747 twice", "7538631747"),
    ("Landline 01223 456789 rang out", "456789"),
    # A number at the END of a sentence. The trailing full stop used to make the
    # whole match impossible, so this shape went to the public repo unmasked.
    ("SMS reply from +447700907077.", "907077"),
    ("Called 07700907077. No answer.", "907077"),
    ("Chase accounts@some-letting-agent.co.uk for the statement", "some-letting-agent"),
    ("Tenant at CB23 6DL reported damp", "6DL"),
)

# Inputs that must survive UNTOUCHED. A scrubber that mangles ordinary report
# text is one somebody turns off, which is the same as not having one.
SELFTEST_UNTOUCHED = (
    "8,690 transactions on 2026-08-12 totalling 1742.60",
    "Base appnqjDpqDniH3IRl table tblqB8b22hKBL4PF1 record recSvXxaEz57i7YQK",
    "Email kevinbrittain@gmail.com and kevin@operationsdirector.co.uk",
    "Version 1.6 vs 1.0, 100 rows of 259, HTTP 200 OK",
    # A decimal must still be safe: the stop is followed by a digit, so it is a
    # decimal point and not the end of a sentence.
    "Balance 01234567.89 is a reference, not a phone number",
    # Real false positive from monitoring/ceo-brief-cron-findings.md: a table
    # cell ending "00" followed by a newline and the next row's date.
    "| invocations | 00\n2026-08-05 | 1 |",
)


# The name rule is exercised against a FIXTURE roster, never the real one. The
# real roster is a list of the people we must not name; putting any of them in
# a test would leak them into the public repo the test lives in.
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
    fail the test suite on a clean clone for a reason that has nothing to do
    with the code under test — the kind of unrelated red that teaches people to
    bypass a gate.
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
