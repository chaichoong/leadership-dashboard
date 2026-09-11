#!/usr/bin/env python3
"""The Adobe Sign audit report travels with every signed document that goes out.

Kevin's ruling (8 Sep 2026): when a document was signed through Adobe Sign and
is then posted or emailed onward, the audit report (Adobe's "Final Audit
Report": who signed, when, from where, the transaction id) must be the last
pages of the PDF. It is what proves the e-signature is genuine to whoever
receives the letter. Documents signed before 9 Sep 2026 are excused; from
then on a send without it is refused.

    adobe_audit.py check  <signed.pdf>                   exit 0 if the audit pages are there
    adobe_audit.py append <signed.pdf> <audit.pdf> [-o OUT]   put the audit pages at the back
    adobe_audit.py selftest

Both send scripts import has_audit_report(); signature-watch.js calls
`append` after downloading the audit report next to the signed PDF.
"""
import os
import sys
from datetime import date

# Documents signed before this day are excused (Kevin: "not essential for
# historical stuff, but moving forwards").
AUDIT_REQUIRED_FROM = date(2026, 9, 9)

# What Adobe prints on its audit pages. Any one of these on one of the last
# three pages counts; a body letter never says these.
AUDIT_PHRASES = ("Final Audit Report", "Audit Report", "Transaction ID", "Agreement ID")


def _reader(path):
    try:
        from pypdf import PdfReader  # noqa: WPS433
    except ImportError as e:                                  # pragma: no cover
        raise RuntimeError("pypdf is not installed for this python: " + str(e))
    return PdfReader(path)


def has_audit_report(path):
    """True when the last pages of the PDF carry Adobe's audit report."""
    r = _reader(path)
    pages = r.pages
    tail = list(pages)[-3:] if len(pages) > 3 else list(pages)
    for p in tail:
        try:
            text = p.extract_text() or ""
        except Exception:                                     # noqa: BLE001
            text = ""
        low = text.lower()
        if any(ph.lower() in low for ph in AUDIT_PHRASES):
            return True
    return False


def append_audit(signed_path, audit_path, out_path=None):
    """Write signed + audit into out_path (default: over the signed file, via
    a temp file and rename). Returns the output path and the page count."""
    from pypdf import PdfWriter
    out_path = out_path or signed_path
    w = PdfWriter()
    for src in (signed_path, audit_path):
        for p in _reader(src).pages:
            w.add_page(p)
    tmp = out_path + ".tmp"
    with open(tmp, "wb") as fh:
        w.write(fh)
    os.replace(tmp, out_path)
    return out_path, len(_reader(out_path).pages)


def audit_required(signed_on):
    """signed_on: a date, or an ISO/'dd Mon yyyy' string; None means unknown
    (treated as required: a document with no known signing date is new)."""
    if signed_on is None:
        return True
    if isinstance(signed_on, date):
        return signed_on >= AUDIT_REQUIRED_FROM
    s = str(signed_on).strip()
    from datetime import datetime
    for fmt, width in (("%Y-%m-%d", 10), ("%d %b %Y", 11), ("%d %b %Y", 10)):
        try:
            return datetime.strptime(s[:width].strip(), fmt).date() >= AUDIT_REQUIRED_FROM
        except ValueError:
            continue
    return True


def audit_problem(signed_path, signed_on=None):
    """Why this signed document may not go out; '' when it may."""
    if not audit_required(signed_on):
        return ""
    try:
        ok = has_audit_report(signed_path)
    except Exception as e:                                    # noqa: BLE001
        return f"could not read {os.path.basename(signed_path)} to check for the audit report ({str(e)[:80]})"
    if ok:
        return ""
    return (f"{os.path.basename(signed_path)} was signed through Adobe Sign but carries no audit "
            "report at the back. Kevin's rule (8 Sep 2026): the audit report proves the e-signature "
            "and goes out with every signed document. In Adobe, open the agreement, Download Audit "
            "Report, then run\n"
            f"         python3 scripts/adobe_audit.py append {signed_path} <audit.pdf>\n"
            "       and send again.")


def selftest():
    import tempfile
    from pypdf import PdfWriter
    d = tempfile.mkdtemp(prefix="adobe-audit-")
    signed = os.path.join(d, "signed.pdf")
    audit = os.path.join(d, "audit.pdf")
    w = PdfWriter(); w.add_blank_page(width=200, height=200); w.write(open(signed, "wb"))
    # An "audit" page with the words Adobe prints, drawn as text via a minimal content stream.
    from pypdf.generic import DecodedStreamObject, NameObject, DictionaryObject
    w2 = PdfWriter(); page = w2.add_blank_page(width=200, height=200)
    font = DictionaryObject({NameObject("/Type"): NameObject("/Font"), NameObject("/Subtype"): NameObject("/Type1"), NameObject("/BaseFont"): NameObject("/Helvetica")})
    page[NameObject("/Resources")] = DictionaryObject({NameObject("/Font"): DictionaryObject({NameObject("/F1"): w2._add_object(font)})})
    stream = DecodedStreamObject(); stream.set_data(b"BT /F1 12 Tf 20 100 Td (Final Audit Report Transaction ID) Tj ET")
    page[NameObject("/Contents")] = w2._add_object(stream)
    w2.write(open(audit, "wb"))
    checks = []
    checks.append(("plain signed has no audit", not has_audit_report(signed)))
    checks.append(("audit page is recognised", has_audit_report(audit)))
    out, n = append_audit(signed, audit)
    checks.append(("append puts the audit at the back", n == 2 and has_audit_report(out) and out == signed))
    checks.append(("required from 9 Sep 2026", audit_required("2026-09-09") and audit_required("09 Sep 2026 10:00") and not audit_required("2026-09-08") and not audit_required("03 Sep 2026")))
    checks.append(("unknown date is required", audit_required(None)))
    plain = os.path.join(d, "plain.pdf")
    w3 = PdfWriter(); w3.add_blank_page(width=200, height=200); w3.write(open(plain, "wb"))
    checks.append(("problem text names the fix", "Download Audit Report" in audit_problem(plain, "2026-09-10") and audit_problem(plain, "2026-09-01") == "" and audit_problem(signed, "2026-09-10") == ""))
    failed = [n for n, ok in checks if not ok]
    print("selftest %s: %d checks%s" % ("OK" if not failed else "FAILED", len(checks), ("; failed: " + ", ".join(failed)) if failed else ""))
    return 0 if not failed else 1


def main(argv):
    if len(argv) < 2 or argv[1] in ("-h", "--help"):
        print(__doc__); return 0
    cmd = argv[1]
    if cmd == "selftest":
        return selftest()
    if cmd == "check":
        p = audit_problem(argv[2], None)
        print("audit report present" if not p else p)
        return 0 if not p else 1
    if cmd == "append":
        out = None
        args = argv[2:]
        if "-o" in args:
            i = args.index("-o"); out = args[i + 1]; args = args[:i] + args[i + 2:]
        path, n = append_audit(args[0], args[1], out)
        print(f"{path}: {n} pages, audit report at the back")
        return 0
    print(__doc__); return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
