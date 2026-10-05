#!/usr/bin/env python3
"""A tenant's details-form link, made by a robot (Cash Flow Voids lane C, 5 Oct 2026).

The Cash Flow Voids agent drafts the RENT CAP email asking a capped tenant to fill in the details form. This
makes the link for it, through the property-manager Worker's robot-only route (POST /tenant-form/robot-link),
with the robots' own key. That key opens that one route and nothing else on the Worker.

Rules, so the agent can always call it and use what it prints:
  * While the Cash Flow Voids agent is on its trial run, no link is made: its drafts are never sent, so a live
    link would only sit unused for 14 days. It prints {"ok": false, "trial": "..."} and exits 0.
  * A tenant who already has a live link keeps it: the Worker answers 409 and this prints
    {"ok": false, "live": true, "expires": "YYYY-MM-DD"} (a new link would end the one the tenant may be using).
  * Otherwise {"ok": true, "url": ..., "expires": ..., "firstName": ...}.

Usage: tenant-link.py make --tenant rec…
Auth: ~/.config/od/pm_robot_key (never printed, never an argument).
"""
import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import agent_email_format as aef  # noqa: E402

WORKER = "https://pm.operationsdirector.co.uk/tenant-form/robot-link"
KEY_PATH = os.path.expanduser("~/.config/od/pm_robot_key")
AGENT = "rec7aHLK1Q8fMLRXH"         # the Cash Flow Voids agent: its trial decides whether links are made
# Cloudflare refuses Python's own User-Agent with a 403 before the Worker sees the call (4 Oct 2026).
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) od-robot/1.0"


def make(tenant, url=WORKER, key_path=KEY_PATH):
    if not re.fullmatch(r"rec[A-Za-z0-9]{14}", tenant or ""):
        return 2, {"ok": False, "error": f"{tenant!r} is not a tenant record id"}
    trial = aef.trial_problem([AGENT])
    if trial:
        return 0, {"ok": False, "trial": f"no link is made while {trial}; write the placeholder your agent file names"}
    try:
        with open(key_path) as fh:
            key = fh.read().strip()
    except OSError as exc:
        return 1, {"ok": False, "error": f"the robots' key could not be read ({exc.strerror})"}
    if not key:
        return 1, {"ok": False, "error": "the robots' key file is empty"}
    req = urllib.request.Request(url, data=json.dumps({"tenantId": tenant}).encode(), method="POST",
                                 headers={"Authorization": "Robot " + key, "Content-Type": "application/json",
                                          "User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return 0, json.load(resp)
    except urllib.error.HTTPError as exc:
        try:
            body = json.load(exc)
        except ValueError:
            body = {}
        if exc.code == 409:
            return 0, {"ok": False, "live": True, "expires": body.get("expires")}
        return 1, {"ok": False, "status": exc.code, "error": str(body.get("error") or exc.reason)[:200]}
    except (urllib.error.URLError, TimeoutError) as exc:
        return 1, {"ok": False, "error": f"the Worker could not be reached ({str(exc)[:120]})"}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    mk = sub.add_parser("make", help="make a tenant's details-form link")
    mk.add_argument("--tenant", required=True)
    a = ap.parse_args(argv)
    code, out = make(a.tenant)
    print(json.dumps(out))
    return code


if __name__ == "__main__":
    sys.exit(main())
