#!/usr/bin/env python3
"""signin_hold.py — does this site keep the robot signed in? Read off the browser ledger.

WHY (Kevin, 2 Oct 2026: "the robot sign-in constantly asks me to re-sign in ...
ensure it doesn't happen moving forwards and only when required")
The 06:40 keep-alive raised a sign-in card for every listed site that read
signed out, every morning, with no memory of whether yesterday's sign-in had
stuck. Three sites could never pass it:
  BW Legal's portal  no account yet, so his window closes still signed out
  EDF                the login lives in a short token: 13 sign-ins, none alive
                     the next morning, one dead 2.1 hours later (15 Sep)
  Amazon             signed in when his window opens (no password asked), sent
                     to the sign-in page in the robot's browser by the next
                     morning, 7 mornings of 7
EDF had 15 cards and Amazon 7. The only way out was a shortSession flag set by
hand in agent-browser.js, which is how GoCardless stopped after six cards on
15 Sep 2026. The next site would have started the same loop.

THE RULE, read off the ledger for one site:
  a sign-in       his sign-in window closing (a `login` line), or the robot
                  reading signed in after a signed-out read with no window in
                  between (his own password in a Your turn window, a sister
                  site's sign-in on the same login, a wrong read put right);
                  that one REPLACES the sign-in before it, unless that one
                  had held, which keeps its place on the record
  it HELD         the robot read signed in HOLD_HOURS or more after it
  it did NOT hold the robot read signed out before that, within HOLD_HOURS of
                  the sign-in or of its last signed-in read
  not judged      neither (too new, or nothing usable was read for longer than
                  HOLD_HOURS before the signed-out read: bot checks, error
                  pages, mornings with no check); it counts for nothing either
                  way and does not break a run
The reads are a daily sample, so a login that lasts between 36 and 60 hours can
fall either side of HELD by the hour he signed in. Either verdict is fine for
such a site: at worst two more asks, or asks that go on.
A site whose last STRIKES judged sign-ins all did not hold is not asked for
daily: it reads "sign in when needed", as a shortSession site does, and a job
that needs it asks then. A site that HAS held a sign-in before needs
STRIKES_HELD in a row: for that site a sign-in that did not hold is far more
likely a window he closed before finishing (the app writes the `login` line
whether or not he got in), and the next morning's ask is the only thing that
tells him so.

Nothing is stored. The verdict is worked out from the ledger each time, so the
first sign-in seen still signed in HOLD_HOURS later puts the site back on the
daily list. It needs the WHOLE ledger (load_events), never a tail: a site
nobody has signed in to for months must not lose its history and start asking
again. If the ledger is ever rotated the rule forgets, and relearns in two asks.

Pure, and shared by session-keepalive.py (raise the card or not) and
estate-status.py (what the Robot sign-ins panel shows).
"""
import json
import os
import re
import urllib.parse
from datetime import datetime, timedelta, timezone

LEDGER = os.path.expanduser("~/knowledge-os/logs/agent-browser/runs.jsonl")
HOLD_HOURS = 36     # seen signed in this long after a sign-in = it held (past the first daily check, into the second day)
STRIKES = 2         # sign-ins running that did not hold before the daily ask stops, for a site that never held one
STRIKES_HELD = 4    # the same, for a site that has held a sign-in before
WHY = "did not stay signed in"      # the panel line's `how`; os/agents/index.html words it for Kevin

# A sign-in page by its address, for `session` lines written before 29 Sep 2026,
# which carry no signinPage. The same test as agent-dispatch.py SIGNIN_DOOR_URL_RE.
DOOR_URL_RE = re.compile(r"oauthSignIn|seclogin|/(?:log-?in|log-?on|sign-?in|signin|auth)(?:/|\?|$)", re.I)


def _at(ts):
    """An ISO time as an aware UTC datetime, or None."""
    if not ts:
        return None
    try:
        d = datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
    except ValueError:
        return None
    if d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc)
    return d.astimezone(timezone.utc)


def load_events(path=None):
    """Every `login` and `session` line of the browser ledger, oldest first as written.

    The whole file, because the rule must not forget. Lines of any other
    command (most of the ledger) are skipped before they are parsed. A missing
    ledger is an empty list: no history means no site is excused."""
    out = []
    try:
        with open(path or LEDGER, encoding="utf-8", errors="replace") as fh:
            for line in fh:
                if '"login"' not in line and '"session"' not in line:
                    continue
                try:
                    rec = json.loads(line)
                except ValueError:
                    continue
                if isinstance(rec, dict) and rec.get("cmd") in ("login", "session"):
                    out.append(rec)
    except FileNotFoundError:
        return []
    return out


def _read(e):
    """What a `session` line saw: "in", "out", or None when it decides nothing.

    A bot check is not a signed-out read, and neither is a read that did not
    land on a sign-in page (an error page, a slow load)."""
    if not isinstance(e.get("signedIn"), bool) or e.get("botCheck"):
        return None
    # The robot's own refresh could not run, or its second read failed: the read
    # says nothing about whether the site would have let it back in (2 Oct 2026).
    refresh = str(e.get("selfRefresh") or "")
    if refresh.startswith("not run") or "second read failed" in refresh:
        return None
    if e["signedIn"]:
        return "in"
    page = e.get("signinPage")
    if page is None:
        url = str(e.get("url") or "")
        try:
            host = (urllib.parse.urlsplit(url).hostname or "").lower()
        except ValueError:
            host = ""
        page = bool(DOOR_URL_RE.search(url)) or host == "account.gov.uk" or host.endswith(".account.gov.uk")
    return "out" if page is True else None


def unheld_signins(events, host, url_host=None, profile="default"):
    """The sign-ins to HOST that did not hold, when they are reason to stop asking daily; else [].

    events    ledger lines (load_events)
    host      the site's key on the robot's list; `session` lines carry it
    url_host  the host of its sign-in page; `login` lines carry that one
              (www.loom.com for loom.com)

    Two windows opened with no read between them are one sign-in (he tried
    again), judged from the later one."""
    hosts = {h for h in (host, url_host) if h}
    timeline = []                                       # (at, "login" | "in" | "out")
    for e in events or []:
        if not isinstance(e, dict) or (e.get("profile") or "default") != profile:
            continue
        at = _at(e.get("at"))
        if not at:
            continue
        if e.get("cmd") == "login" and e.get("host") in hosts:
            timeline.append((at, "login"))
        elif e.get("cmd") == "session" and e.get("site") == host and _read(e):
            timeline.append((at, _read(e)))
    timeline.sort(key=lambda t: t[0])
    hold = timedelta(hours=HOLD_HOURS)

    def held(s):
        return s["lastIn"] is not None and s["lastIn"] - s["at"] >= hold

    signins = []                                        # {at, lastIn, outAt}: the sign-in, its last signed-in read, its first signed-out read
    for at, kind in timeline:
        cur = signins[-1] if signins else None
        if kind == "login":
            if cur and cur["lastIn"] is None and cur["outAt"] is None:
                cur["at"] = at                          # no read since the last window: the same sign-in
            else:
                signins.append({"at": at, "lastIn": None, "outAt": None})
        elif kind == "in":
            again = {"at": at, "lastIn": at, "outAt": None}
            if cur is None:
                signins.append(again)
            elif cur["outAt"] is None:
                cur["lastIn"] = at
            elif held(cur):
                signins.append(again)                   # a sign-in that held keeps its place on the record
            else:
                # Signed in again with no window on the ledger. It takes the place of
                # the sign-in before it, never a second strike beside it: one window
                # whose reads went out, in, out must count once (Spotify's door read
                # signed out and, 39 seconds later, signed in, 15 Sep 2026).
                signins[-1] = again
        elif cur and cur["outAt"] is None:
            cur["outAt"] = at
    judged = []                                         # (at, held) for every sign-in that can be judged
    for s in signins:
        if held(s):
            judged.append((s["at"], True))
        # Signed out with nothing usable read for longer than HOLD_HOURS before it
        # (bot checks, error pages, mornings with no check) says nothing about
        # whether it held: not judged.
        elif s["outAt"] is not None and s["outAt"] - (s["lastIn"] or s["at"]) <= hold:
            judged.append((s["at"], False))
    need = STRIKES_HELD if any(h for _, h in judged) else STRIKES
    last = judged[-need:]
    if len(last) < need or any(h for _, h in last):
        return []
    return [at for at, _ in last]


# ─── HIS OWN TRY DID NOT GET THE ROBOT IN (Kevin, 8 Oct 2026) ─────────────────
# "There are a lot of them that ask me to sign in or say Add this site. Every
# time I add it or every time I try and sign in, it doesn't disappear." Swinton
# had three of his windows close on 7 and 8 Oct and every robot read after each
# still landed on the login page; the wall asked again, for ever. These two read
# his try off the ledger, so the sweep can send such a wall back to its agent
# and `block` can refuse to raise it again. A window closing is not proof he got
# in (the app writes `login` either way), so callers say his window closed,
# never that he signed in.
#
# Hosts match EXACTLY (review, 8 Oct 2026): landlordaxainsurance.com and its www.
# site are separate sign-ins, and a parent's read said nothing about the child.
# Callers pass every address the wall can be signed in at (its host, its entry,
# its sign-in page). Only a signed-out read within TRY_READ_HOURS of his window
# counts: one the next morning may be a sign-in that worked and expired overnight.
TRY_READ_HOURS = 2


def kevin_login_after(events, hosts, since, profile="default"):
    """(at, host) of his newest sign-in window (a `login` line) on HOSTS that closed after SINCE,
    or None. A window opened from a blocked robot's "+ Add this site" counts for the address it
    was opened for (`forWall`), wherever he signed in: HOST is then where he did."""
    hosts = {str(h).lower() for h in hosts if h}
    since_at = _at(since)
    best = None
    for e in events or []:
        if not isinstance(e, dict) or e.get("cmd") != "login" or (e.get("profile") or "default") != profile:
            continue
        if e.get("timedOut"):
            continue                            # he walked away from it: not a try (8 Oct 2026)
        at = _at(e.get("at"))
        h = str(e.get("host") or e.get("site") or "").lower()
        if not at or (since_at and at <= since_at):
            continue
        if h not in hosts and str(e.get("forWall") or "").lower() not in hosts:
            continue
        if best is None or at > best[0]:
            best = (at, str(e.get("at")), h)
    return (best[1], best[2]) if best else None


def kevin_signin_failed(events, hosts, since, profile="default"):
    """(login_at, out_at, host) when the robot's first usable read of HOSTS after his newest
    sign-in window there (after SINCE) was signed out, within TRY_READ_HOURS of it, and nothing
    has read signed in since; else None."""
    hosts = {str(h).lower() for h in hosts if h}
    login = kevin_login_after(events, hosts, since, profile)
    if not login:
        return None
    login_at = _at(login[0])
    reads = []
    for e in events or []:
        if not isinstance(e, dict) or e.get("cmd") != "session" or (e.get("profile") or "default") != profile:
            continue
        at = _at(e.get("at"))
        if not at or at <= login_at or str(e.get("site") or "").lower() not in hosts:
            continue
        r = _read(e)
        if r:
            reads.append((at, r, str(e.get("at"))))
    reads.sort(key=lambda x: x[0])
    if not reads or any(r == "in" for _, r, _ in reads):
        return None
    first_at, _, first_iso = reads[0]
    if first_at - login_at > timedelta(hours=TRY_READ_HOURS):
        return None
    return (login[0], first_iso, login[1])
