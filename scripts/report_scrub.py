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
_PHONE_CANDIDATE = re.compile(
    r"(?<![\d/.\-])(\+ ?44[\d \-()]{7,15}\d|0\d[\d \-]{6,12}\d)(?![\d/.\-])"
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


RULES = (
    ("phone", _PHONE_CANDIDATE, _mask_phone),
    ("email", _EMAIL, _mask_email),
    ("postcode", _POSTCODE, _mask_postcode),
)


def scrub(text):
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
    return text, hits


# Known-bad inputs, each with the substring that must NOT survive. If a pattern
# is broken or deleted, one of these comes back unmasked and every caller stops.
SELFTEST_CASES = (
    ("SMS reply from +447538631747 about a tap", "7538631747"),
    ("SMS reply from +44 7538 631747 about a tap", "631747"),
    ("Called 07538631747 twice", "7538631747"),
    ("Landline 01223 456789 rang out", "456789"),
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
    # Real false positive from monitoring/ceo-brief-cron-findings.md: a table
    # cell ending "00" followed by a newline and the next row's date.
    "| invocations | 00\n2026-08-05 | 1 |",
)


def selftest():
    """Return a list of failure strings. Empty list means the patterns work."""
    failures = []
    for text, must_go in SELFTEST_CASES:
        out, hits = scrub(text)
        if must_go in out:
            failures.append("did not mask %r in %r (got %r)" % (must_go, text, out))
        elif not hits:
            failures.append("masked %r but reported no hit" % text)
    for text in SELFTEST_UNTOUCHED:
        out, hits = scrub(text)
        if out != text:
            failures.append("false positive: %r became %r" % (text, out))
    return failures


if __name__ == "__main__":
    import sys

    problems = selftest()
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
