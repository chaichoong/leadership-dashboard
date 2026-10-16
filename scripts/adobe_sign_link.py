#!/usr/bin/env python3
"""The Adobe Sign request in Kevin's Gmail, for the robot's second signing door (16 Oct 2026).

Kevin's ruling: a signature comes to him as a card, and once he approves that exact document the
robot signs it for him. Adobe sends a link-only signer (no Adobe account) a "Signature requested on
"<name>"" email whose "Review and sign" address IS the credential. His safeguard of 28 Aug 2026,
in code: only a link from adobesign@adobesign.com, in mail addressed to kevinbrittain@gmail.com,
on Adobe's own signing host. A look-alike "please sign" email is the obvious attack.

    adobe_sign_link.py find   --agreement NAME            the newest request: {messageId, when, linkId, link}
    adobe_sign_link.py signed --agreement NAME --since ISO   Adobe's "You signed" email after ISO?

`linkId` ("tsid-" and a fingerprint of the signer token) names the request on the card: the token
itself never goes on a card, a note or a log. agent-browser.js reads this script's stdout and keeps
the link in memory only.
"""
import hashlib
import importlib.util
import json
import os
import re
import sys
from datetime import datetime, timezone
from urllib.parse import urlsplit, parse_qs

ACCOUNT = "kevinbrittain@gmail.com"
SENDER = "adobesign@adobesign.com"
SIGN_HOST_RE = re.compile(r"(?:^|\.)(?:documents\.adobe\.com|adobesign\.com|echosign\.com)$", re.I)
SIGN_PATH_RE = re.compile(r"^/public/esign$", re.I)


def _triage():
    here = os.path.dirname(os.path.abspath(__file__))
    spec = importlib.util.spec_from_file_location("inbound_triage", os.path.join(here, "inbound-triage.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def fail(msg, code=1):
    print(json.dumps({"error": msg}))
    sys.exit(code)


def addr_of(header):
    """The bare addresses in a From/To header, lower case."""
    return [a.lower() for a in re.findall(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+", str(header or ""))]


def link_id(href):
    tsid = (parse_qs(urlsplit(href).query).get("tsid") or [""])[0]
    return "tsid-" + hashlib.sha256(tsid.encode()).hexdigest()[:40] if tsid else ""


def request_link(msg, name):
    """(link, why-not) for one message: the Review and sign address of a real Adobe request for
    `name` addressed to Kevin, or '' and the reason it is not one."""
    h = msg.get("headers") or {}
    frm = addr_of(h.get("from"))
    if frm != [SENDER]:
        return "", f"not sent by {SENDER} ({', '.join(frm) or 'no sender'})"
    if ACCOUNT not in addr_of(h.get("to")):
        return "", f"not addressed to {ACCOUNT}"
    if str(h.get("subject") or "").strip() != f'Signature requested on "{name}"':
        return "", "not the signature request for that exact document"
    hrefs = []
    for l in msg.get("links") or []:
        if str(l.get("text") or "").strip().lower() != "review and sign":
            continue
        u = urlsplit(str(l.get("href") or ""))
        if u.scheme == "https" and SIGN_HOST_RE.search(u.hostname or "") and SIGN_PATH_RE.match(u.path or "") \
                and link_id(l["href"]):
            hrefs.append(l["href"])
    ids = {link_id(h_) for h_ in hrefs}
    if not hrefs:
        return "", "no Review and sign link on Adobe's own signing host"
    if len(ids) > 1:
        return "", "two different signing links in one email"
    return hrefs[0], ""


def find(name, lister=None):
    lister = lister or _triage().worker_list
    msgs, _ = lister(q=f'from:{SENDER} subject:"{name}" newer_than:90d', max_pages=1, account=ACCOUNT)
    seen = []
    for msg in sorted(msgs, key=lambda m: int(m.get("internalDate") or 0), reverse=True):
        link, why = request_link(msg, name)
        if link:
            when = datetime.fromtimestamp(int(msg.get("internalDate") or 0) / 1000, timezone.utc).isoformat()
            return {"messageId": msg.get("id"), "when": when, "linkId": link_id(link), "link": link}
        seen.append(f"{msg.get('id')}: {why}")
    fail(f'no Adobe signature request for "{name}" addressed to {ACCOUNT} in the last 90 days'
         + (f" ({'; '.join(seen[:4])})" if seen else ""))


def signed(name, since_iso, lister=None):
    """Adobe's own "You signed" email for `name` to Kevin, received after `since_iso`."""
    lister = lister or _triage().worker_list
    since = datetime.fromisoformat(since_iso.replace("Z", "+00:00"))
    msgs, _ = lister(q=f'from:{SENDER} subject:"{name}" newer_than:2d', max_pages=1, account=ACCOUNT)
    for msg in msgs:
        h = msg.get("headers") or {}
        at = datetime.fromtimestamp(int(msg.get("internalDate") or 0) / 1000, timezone.utc)
        if addr_of(h.get("from")) == [SENDER] and ACCOUNT in addr_of(h.get("to")) \
                and str(h.get("subject") or "").strip() == f'You signed: "{name}"' and at >= since:
            return {"signed": True, "messageId": msg.get("id"), "when": at.isoformat()}
    return {"signed": False}


def main(argv):
    cmd = argv[1] if len(argv) > 1 else ""
    args = argv[2:]
    get = lambda k: args[args.index(k) + 1] if k in args[:-1] else ""
    name = get("--agreement").strip()
    if cmd in ("find", "signed") and not name:
        fail("--agreement is required: the document name exactly as Adobe shows it")
    if cmd == "find":
        print(json.dumps(find(name)))
        return 0
    if cmd == "signed":
        since = get("--since")
        if not since:
            fail("--since is required: when the robot pressed Submit (ISO time)")
        print(json.dumps(signed(name, since)))
        return 0
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
