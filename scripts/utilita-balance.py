#!/usr/bin/env python3
"""utilita-balance.py — daily Duckworth electric balances to Kevin and Roy.

WHY (Kevin, 18 Sep 2026)
------------------------
Two Duckworth flats let as serviced accommodation run on Utilita pay-as-you-go
electric. Roy tops them up by hand and has forgotten, cutting the power off with
guests in and costing reviews. This reads both balances every morning and says
them in one Slack message, so nobody has to remember to go and look.

NO PASSWORD LIVES ANYWHERE IN THIS CHAIN
----------------------------------------
Utilita's login form carries a Cloudflare Turnstile challenge, so an automated
credential login would mean defeating bot-detection: prohibited, and fragile
besides, because it breaks silently the day Cloudflare raises the challenge.
agent-browser.js refuses to type a password at all, by design, and that
guarantee is not weakened for a meter reading. Instead Kevin signs each profile
in once by hand and this only READS.

THE SESSION IS A ROLLING HOUR, MEASURED NOT ASSUMED (18 Sep 2026)
-----------------------------------------------------------------
Utilita issues no remember-me cookie, with or without the box ticked. Its
`myutilita_session` cookie lasts ONE HOUR, and every visit restarts the hour:
a visit at 17:06 moved the expiry to 18:06, a visit at 17:08 moved it to 18:08.
So the session sustains itself as long as something looks in within the hour,
which is what `keepalive` is for. It is NOT in session-keepalive.py's list on
purpose: that script never passes --profile, so it would test the empty
`default` profile and file a false SIGN-IN NEEDED task every morning.

THE METER IS THE IDENTITY, NEVER THE ADDRESS
--------------------------------------------
Utilita shows Apartment 1's dashboard address WITH its flat number and
Apartment 2's WITHOUT one ("Duckworth Building, FY8 1SQ" for both, near
enough). Pairing a balance to a flat by address would have put Apartment 2's
figure under Apartment 1's name and nothing would have errored, which is how
Roy ends up topping up a meter that was already full while the other goes
dark. Each flat is pinned to its electricity top-up number instead, and a
mismatch REFUSES to report that flat rather than guess.

ABSENCE IS REPORTED, NEVER SILENT
---------------------------------
A lapsed session, a changed meter number or an unparseable page all say so in
the message in place of a figure. A watcher that quietly reports nothing is
worse than no watcher, because it reads as "all fine" on the morning the
meter is empty. `parse_energy` therefore returns a REFUSAL with a reason rather
than a number whenever the page does not look right, and the refusal is what
appears in the message.

A WRONG NUMBER IS THE ONLY UNRECOVERABLE OUTCOME
------------------------------------------------
The first version of this file claimed to guard the balance against the
`OTHER CHARGES` line and did not. An independent review found it, and all of
the following were then MEASURED on 18 Sep 2026 rather than argued about:

  * `OTHER CHARGES / £1350.60` sits at start+7 on the real Apartment 1 page,
    INSIDE the old fixed eight-line window. It lost only because a valid
    £20.26 happened to appear first. With the balance tile not yet painted, or
    a meter in debt showing `-£5.20` (which the money regex did not match),
    the watcher reported "£1350.60 — 5 days left" on an EMPTY meter, raised no
    alarm and exited 0. The search now stops at the end of the balance card,
    negatives parse, and any figure over BALANCE_CEILING_GBP is refused.
  * `£12.40 — Less than a day left` and `Off supply` raised no flag at all,
    because the flag read only the number against the floor. The days-left
    line is now its own alarm (`row_alarm`).
  * The cron fires from 00:05, and the old gate sent the daily message THERE:
    at midnight, to a sleeping Roy, on a figure read at the lowest-usage hour.
    Nothing sends before EARLIEST_HOUR, and a meter that empties LATER in the
    day now earns one extra message instead of silence until tomorrow.
  * `all([])` is True, so a trimmed accounts list sent a message with no flats
    in it and marked the day done. `expectedAccounts` is the control.
  * `"/energy" in url` matched `/login?returnUrl=/energy`, so a signed-OUT
    session read as signed in and the message withheld the sign-in line.
    `signed_in` now mirrors agent-browser.js's own `sessionVerdict`.
  * Exiting 1 on a low balance made job-queue record the run as FAILED, so the
    watcher reported itself broken on exactly the mornings a meter was low.
    A delivered message is a success; the low balance is IN it.

Usage
  utilita-balance.py run               HOURLY job. Always reads (which holds the
                                       session open), sends at most once a day
                                       plus one alarm if a meter empties later
  utilita-balance.py run --dry-run     read and print the message, send nothing
  utilita-balance.py run --force       send now regardless of the daily mark
  utilita-balance.py read              read both, print the report, send nothing
  utilita-balance.py keepalive         touch both sessions so the hour restarts
  utilita-balance.py selftest          offline checks on the parser and gates

Exit codes, for the launchd wrapper: 0 when the message was delivered (a low
balance is the job WORKING), 1 when delivery failed, when a recipient missed
out, or when a flat had a technical fault. A run that deliberately stays quiet
exits 0 — alarming hourly about a problem already reported once is how a
channel gets muted.
"""
import json
import os
import re
import subprocess
import sys
from datetime import datetime

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG = os.path.expanduser("~/.config/od/utilita_accounts.json")
RELAY_KEY_PATH = os.path.expanduser("~/.config/od/slack_relay_key")
RELAY_URL = "https://apple-inbound.kevinbrittain.workers.dev/slack-relay"
STATE_DIR = os.path.expanduser("~/knowledge-os/logs/utilita-balance")
LEDGER = os.path.join(STATE_DIR, "readings.jsonl")
ENERGY_URL = "https://my.utilita.co.uk/energy"

# Utilita writes the days-left line in words as often as numbers, and an empty
# meter says something different again. Anything unrecognised is carried
# through verbatim rather than dropped, so a new phrasing shows up in the
# message instead of vanishing from it.
DAYS_PATTERNS = (
    r"^\d+\s+days?\s+left$",
    r"^More than a week left$",
    r"^Less than a day left$",
    r"^No credit",
    r"^Off supply",
)


def node_bin():
    """Newest nvm node, resolved in Python.

    Never falls back to a bare "node": launchd runs with a minimal PATH, so that
    raised FileNotFoundError out of subprocess.run and killed the whole run with
    a traceback before any message was built. Matches session-keepalive.py,
    which globs ~/.nvm rather than shelling out.
    """
    import glob
    found = sorted(glob.glob(os.path.expanduser("~/.nvm/versions/node/*/bin/node")))
    if found:
        return found[-1]
    for p in ("/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"):
        if os.path.exists(p):
            return p
    return None


def load_config():
    if not os.path.exists(CONFIG):
        sys.exit(f"ERROR: no Utilita config at {CONFIG}")
    with open(CONFIG) as fh:
        return json.load(fh)


# Everything that ENDS the balance card. The balance search stops at the first
# of these rather than counting lines.
#
# This is the whole bug, and it was luck that hid it. The window used to be a
# fixed eight lines after "Balance", and on the real Apartment 1 page
# "OTHER CHARGES / £1350.60" sits at start+7 — INSIDE it. It lost only because
# a valid £20.26 appeared first. Measured on 18 Sep 2026: with the balance tile
# not yet painted, or with a meter in debt showing "-£5.20" (which the money
# regex does not match), the parser reported "£1350.60 — 5 days left" on an
# EMPTY meter, raised no alarm and exited 0. That is the outage this watcher
# exists to prevent, wearing the face of a healthy reading.
CARD_END_MARKERS = ("other charges", "electricity top-up number",
                    "gas top-up number", "top-up number", "usage",
                    "past 7 days", "past 30 days", "my utilita",
                    "meter readings", "utilita extra")

# The balance sits DIRECTLY under the heading, after the REFRESH button: index 1
# of the card on both real pages. A generous window is how a stray amount wins:
# with six lines, "Balance / REFRESH / 50p / Top up / £20 / 5 days left"
# reported the top-up button's £20 as the balance, because "50p" does not match
# the money regex and so raised no ambiguity. Three lines is the whole card
# header. Refusing is recoverable; a wrong number is not.
BALANCE_WINDOW = 3

# A pay-as-you-go meter rarely holds this much. Over it, the figure is still
# REPORTED, with a "check this" note and attention raised — never refused.
# Refusing meant a genuine £620 balance was never shown and the job logged
# itself failed hourly until the meter dropped below the line.
BALANCE_IMPLAUSIBLE_GBP = 300


def parse_energy(text):
    """Pull balance, days-left and top-up number out of the /energy page text.

    Kept a pure function so the tests read the real one instead of a copy.

    Returns `refused` with a reason instead of a figure whenever the page does
    not look the way it should. Reporting nothing is recoverable; reporting the
    wrong number is what puts guests in the dark.
    """
    lines = [l.strip() for l in (text or "").split("\n")]
    lines = [l for l in lines if l]
    out = {"balance": None, "balanceGbp": None, "daysLeft": None,
           "daysLeftRecognised": None, "topUpNumber": None, "refused": None,
           "implausible": False}

    # A leading minus means the meter is in debt on emergency credit. It must
    # parse (and alarm), never fall through to the next money line on the page.
    # U+2212 MINUS SIGN and U+2013 EN DASH are included because a real page
    # rendering "−£5.20" with a typographic minus fell through the old regex to
    # the NEXT money line and reported £20.00 of credit on a meter in debt.
    #
    # Thousands are GROUPED, not "any commas anywhere": the old [\d,]+ read
    # "£2,50" as £250.00, a hundred times high, with no flag. A decimal comma
    # is unlikely on a UK page, which is exactly why it would never have been
    # noticed.
    money = re.compile(r"^([-\u2212\u2013]?)£\s?([-\u2212\u2013]?)"
                       r"(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{1,2}))?$")

    heads = [i for i, l in enumerate(lines) if l.lower() == "balance"]
    if not heads:
        out["refused"] = "no balance shown on the page"
        return out
    if len(heads) > 1:
        # A Utilita account can hold more than one supply, and both flats are in
        # one building. Two cards means the balance and the meter number below
        # could come from different supplies, and the meter gate would then
        # validate the wrong pairing. Refuse rather than pick one.
        out["refused"] = f"the page shows {len(heads)} balances; cannot tell which is this meter"
        return out
    start = heads[0]

    # Walk forward only to the end of the balance card.
    #
    # The marker test is an EXACT line match, not a substring. "usage" as a
    # substring ended the card on the line "See your usage", which sat above
    # "Off supply" — so a meter that was off supply reported £12.40 with no
    # days line and no alarm at all, because the alarm reads the days line.
    card = []
    for l in lines[start + 1:]:
        if l.lower().strip(" :·|") in CARD_END_MARKERS:
            break
        card.append(l)

    # AMBIGUITY IS REFUSED, and the figure must sit next to its heading.
    #
    # The balance used to be "the first money-shaped line anywhere in the card",
    # with no position anchor, so any format the regex missed fell through to the
    # next money line. Measured: "Balance / REFRESH / 50p / Top up / £20 /
    # 5 days left" reported £20.00, and a card with a typographic minus reported
    # the top-up button's £20.00 as credit. Two money lines in one card means
    # the page is not the shape this parser understands, and guessing which is
    # the balance is precisely the guess that puts guests in the dark.
    monies = [(i, l) for i, l in enumerate(card[:BALANCE_WINDOW]) if money.match(l)]
    if not monies:
        out["refused"] = "the balance had not loaded on the page"
        return out
    if len(monies) > 1:
        out["refused"] = ("the balance card shows " + str(len(monies))
                          + " amounts (" + ", ".join(l for _, l in monies)
                          + "); cannot tell which is the balance")
        return out

    m = money.match(monies[0][1])
    negative = bool(m.group(1) or m.group(2))
    pence = m.group(4) or "00"
    value = float(m.group(3).replace(",", "") + "." + pence.ljust(2, "0"))
    out["balanceGbp"] = -value if negative else value
    out["balance"] = ("-£" if negative else "£") + f"{value:,.2f}"
    # Implausible is FLAGGED, never refused. A hard refusal above £500 meant a
    # genuine £620 balance was never reported and the job logged itself failed
    # every hour until the meter dropped — the same "reports itself broken"
    # pattern the exit-code fix removed. The structural guards above are what
    # make OTHER CHARGES unreachable; this is only a sanity note.
    if value > BALANCE_IMPLAUSIBLE_GBP:
        out["implausible"] = True

    for l in card:
        if any(re.match(p, l, re.I) for p in DAYS_PATTERNS):
            out["daysLeft"], out["daysLeftRecognised"] = l, True
            break
    if out["daysLeft"] is None:
        # Carried verbatim, as the header promises. Utilita rewords this line
        # ("About 1 day left"), and a silently dropped urgency line is worse
        # than an unfamiliar one.
        for l in card:
            if re.search(r"left\b|credit|supply", l, re.I) and not money.match(l):
                out["daysLeft"], out["daysLeftRecognised"] = l, False
                break

    # Scoped to this card's supply, after the balance heading — never the first
    # "top-up number" anywhere on the page.
    for i, l in enumerate(lines[start:], start=start):
        if "top-up number" in l.lower():
            for nxt in lines[i + 1:i + 3]:
                digits = re.sub(r"\s", "", nxt)
                if re.fullmatch(r"\d{10,25}", digits):
                    out["topUpNumber"] = digits
                    break
            if out["topUpNumber"]:
                break
    return out


# Mirrors sessionVerdict() in scripts/agent-browser.js:398. Kept in step by
# tests/utilita-balance.test.js, which drives the JS one and this one over the
# same URLs and fails if they disagree.
#
# The bug: the old test was `"/energy" in url`, and
# "my.utilita.co.uk/login?returnUrl=/energy" contains "/energy". A Turnstile or
# email-first login step renders no password box, so a SIGNED-OUT session read
# as signed in, and the message then said "the balance was not on the page" and
# withheld the Robot sign-in line that exists for exactly this case.
AT_DOOR = re.compile(r"oauthSignIn|seclogin|/(?:log-?in|sign-?in|signin|login|auth)(?:/|\?|$)", re.I)


def signed_in(url, password_fields):
    if password_fields is None or int(password_fields) != 0:
        return False
    return not AT_DOOR.search(url or "")


def meter_problem(pinned, seen):
    """Is the meter on this login still the one pinned to this flat?

    A pure function so a test can break it and see the break. The first version
    of this lived inline in read_account(), and disabling it left every test
    green because they all drove the message builder instead of the gate: the
    guard existed and proved nothing.

    Unknown (either side missing) is NOT a mismatch. Utilita occasionally
    renders the dashboard without the top-up number, and refusing to report a
    balance over a missing line would cry wolf; refusing over a DIFFERENT
    number is the real signal.
    """
    pinned, seen = str(pinned or ""), str(seen or "")
    if not pinned or not seen or pinned == seen:
        return None
    return ("METER CHANGED: this login now shows meter …" + seen[-4:]
            + ", not …" + pinned[-4:]
            + ". Not reporting a balance until that is explained")


# Longer than agent-browser.js's own 10-minute wait for the profile lock
# (scripts/agent-browser.js:442). It used to be 180s, which is SHORTER, so any
# real contention (Kevin signing in, a second tick) guaranteed a timeout that
# reported "the page did not load in time" when the truth was "the profile was
# busy". Worse, subprocess kills node only: the Chromium it launched survived,
# and waitForProfile's pgrep then saw that orphan for ever, so every later run
# also timed out and added another orphan. start_new_session + killpg fixes the
# orphan; the longer timeout stops the false alarm.
READ_TIMEOUT_S = 11 * 60


def read_account(acct, node=None):
    """One flat. Returns a row that always states what it knows and what it does not."""
    node = node or node_bin()
    row = {"label": acct["label"], "profile": acct["profile"], "ok": False,
           "signedIn": None, "balance": None, "balanceGbp": None,
           "daysLeft": None, "daysLeftRecognised": None, "meterLast4": None,
           "problem": None}
    if not node:
        row["problem"] = "no node on this machine to drive the browser"
        return row
    proc = None
    try:
        proc = subprocess.Popen(
            [node, os.path.join(REPO, "scripts", "agent-browser.js"), "read",
             "--url", ENERGY_URL, "--profile", acct["profile"],
             "--wait", "6000", "--max-text", "4000"],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            start_new_session=True)
        out, err = proc.communicate(timeout=READ_TIMEOUT_S)
    except subprocess.TimeoutExpired:
        # Kill the GROUP, or the headless Chromium outlives node and holds the
        # profile lock against every future run.
        try:
            os.killpg(os.getpgid(proc.pid), 9)
            proc.communicate(timeout=30)
        except (OSError, subprocess.SubprocessError, subprocess.TimeoutExpired):
            pass
        row["problem"] = "the page did not load in time"
        return row
    except (OSError, ValueError) as e:                                  # noqa: BLE001
        # A missing node binary raised FileNotFoundError here and killed the
        # whole run with a traceback before any message was built, which broke
        # the "absence is reported, never silent" promise at the one moment it
        # mattered.
        print(f"[{acct['label']}] could not start the browser: {e}", file=sys.stderr)
        row["problem"] = "could not start the browser"
        return row

    if proc.returncode != 0:
        # The reason goes to the job log, NOT into the message: stderr carries
        # /Users/kevinbrittain/... profile paths, and this message is read by Roy.
        print(f"[{acct['label']}] browser exit {proc.returncode}: "
              f"{(err or '').strip()[:400]}", file=sys.stderr)
        row["problem"] = "could not open the page"
        return row

    last = [l for l in (out or "").strip().split("\n") if l.strip()]
    try:
        data = json.loads(last[-1]) if last else {}
    except (ValueError, IndexError):
        row["problem"] = "the browser returned something unreadable"
        return row

    row["signedIn"] = signed_in(data.get("url") or "", data.get("passwordFields"))
    if not row["signedIn"]:
        row["problem"] = "SIGN-IN NEEDED"
        return row

    got = parse_energy(data.get("text") or "")
    # The meter, not the address, decides which flat this is.
    mismatch = meter_problem(acct.get("topUpNumber"), got["topUpNumber"])
    if mismatch:
        row["problem"] = mismatch
        return row
    if got["refused"]:
        row["problem"] = got["refused"]
        return row

    row.update({"ok": True, "balance": got["balance"], "balanceGbp": got["balanceGbp"],
                "daysLeft": got["daysLeft"],
                "daysLeftRecognised": got["daysLeftRecognised"],
                "meterLast4": (got["topUpNumber"] or "")[-4:] or None})
    return row


# The days-left line is its OWN alarm, independent of the number beside it.
# Measured 18 Sep 2026: "£12.40 — Less than a day left" raised no flag, and
# "Off supply" raised none either, because the flag read only the balance
# against lowBalanceGbp. On an electric-heated flat those are the emergency,
# and the balance alone does not say so.
ALARM_DAYS = re.compile(r"no credit|off supply|less than a day|^0 days?\b", re.I)

# "5 days left" -> 5. Utilita calculates this itself from recent consumption, so
# it tightens on its own when a flat fills up with guests, which a pounds figure
# cannot do. £20 lasts about five days at roughly £4/day, so a £10 floor gave
# barely two and a half days' notice: too tight for serviced accommodation,
# where a Friday warning means an outage over a paid weekend.
DAYS_NUMBER = re.compile(r"^(\d+)\s+days?\s+left$", re.I)
# Fewer than this many days left and somebody needs to act today.
ALARM_DAYS_LEFT = 3


def days_left_number(text):
    """The number of days in a days-left line, or None if it does not give one.

    None is the honest answer for "More than a week left" and for any wording
    Utilita invents later; the pounds floor and the ALARM_DAYS words cover those,
    and daysLeftRecognised already flags an unfamiliar phrase in the message.
    """
    m = DAYS_NUMBER.match(str(text or "").strip())
    return int(m.group(1)) if m else None


def row_alarm(row, low_gbp, alarm_days=ALARM_DAYS_LEFT):
    """Does this flat need somebody to act TODAY? Pure, so it is testable.

    DAYS FIRST, pounds as a backstop. Four independent triggers, any one enough:
      * the days-left line gives a number at or under alarm_days
      * the days-left line says no credit, off supply, or less than a day
      * the balance is NEGATIVE (the meter is on emergency credit)
      * the balance is below the pounds floor

    Days lead because Utilita recomputes them from actual consumption, so the
    warning tightens by itself when guests arrive. Pounds stay as the backstop
    for a page that renders no days line at all.
    """
    if not row.get("ok"):
        return False
    days = days_left_number(row.get("daysLeft"))
    if days is not None and days <= alarm_days:
        return True
    if ALARM_DAYS.search(str(row.get("daysLeft") or "")):
        return True
    bal = row.get("balanceGbp")
    return bool(bal is not None and (bal < low_gbp or bal < 0))


def build_message(rows, low_gbp, when=None, alarm_days=ALARM_DAYS_LEFT):
    """Returns (text, attention, alarm).

    `attention` means something is technically wrong and the job should report a
    failure. `alarm` means a METER needs topping up, which is the job working
    correctly, and is what earns a second message on a day one was already sent.
    """
    when = when or datetime.now()
    head = "*Duckworth electric, " + when.strftime("%a %-d %b") + "*"
    body, attention, alarm = [], False, False
    for r in rows:
        if r["ok"]:
            days = (" — " + r["daysLeft"]) if r["daysLeft"] else ""
            if r.get("daysLeftRecognised") is False:
                days += "  _(new wording from Utilita)_"
            flag = ""
            if row_alarm(r, low_gbp, alarm_days):
                flag, alarm = "  ⚠️ *top up today*", True
            # The meter this figure came from, so a silently missing identity
            # check is visible rather than inert. CLAUDE.md's rule: an invariant
            # with no control reads as a pass for ever.
            last4 = r.get("meterLast4")
            meter = ("  _(meter …" + last4 + ")_") if last4 else "  _(meter not shown)_"
            # The days line is the SECOND alarm channel, so its absence needs a
            # control too. Without one it could switch itself off invisibly: a
            # page that lost the line reported the balance alone and nothing
            # said the urgency signal was missing.
            if not r["daysLeft"]:
                days, attention = "  _(days left not shown)_", True
            if r.get("implausible"):
                days += "  ⚠️ _unusually high for a meter, check this_"
                attention = True
            body.append("*" + r["label"] + "*: " + r["balance"] + days + flag + meter)
        else:
            attention = True
            body.append("*" + r["label"] + "*: _" + (r["problem"] or "no reading") + "_")
    if any(r.get("problem") == "SIGN-IN NEEDED" for r in rows):
        body.append("")
        body.append("_Open the Robot sign-in app on the Desktop to put that right._")
    body.append("")
    body.append("_Read at " + when.strftime("%H:%M") + "._")
    return head + "\n" + "\n".join(body), attention, alarm


def send_slack(text, recipients):
    if not os.path.exists(RELAY_KEY_PATH):
        # A DICT, like every other return here. This branch returned a 2-tuple
        # and every caller indexes the result by name, so a rotated or renamed
        # key file did not produce the designed message — it produced
        # "TypeError: tuple indices must be integers" and no message at all.
        # Introduced by the round-1 refactor, found by the round-2 review.
        return {"anyDelivered": False, "delivered": [], "failed": [],
                "detail": f"no relay key at {RELAY_KEY_PATH}"}
    with open(RELAY_KEY_PATH) as fh:
        key = fh.read().strip()
    import urllib.error
    import urllib.request
    payload = json.dumps({"recipients": recipients, "text": text}).encode()
    req = urllib.request.Request(RELAY_URL, data=payload, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("X-Relay-Key", key)
    # Cloudflare's browser integrity check answers Python's default
    # "Python-urllib/3.x" with 403 error 1010, while the same request from curl
    # sails through (measured 18 Sep 2026). Nothing in the worker is reached, so
    # the failure would have looked like a broken relay rather than a blocked
    # client, every morning, quietly.
    req.add_header("User-Agent", "od-utilita-balance/1.0 (+scheduled job, Kevin's Mac)")

    # READ THE PER-RECIPIENT RESULT, not the status code.
    #
    # The worker answers 502 when ANY recipient fails, and urllib raises on 502.
    # Treating that as a total failure meant the daily mark was never written,
    # so the next tick sent again: if Roy's DM ever failed permanently (he
    # leaves the workspace, the lookup scope changes), Kevin would have received
    # the same message 24 times a day for ever, having already received it the
    # first time. "Delivered to nobody" and "delivered to one of two" are
    # different facts and the caller needs both.
    body, code = None, None
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            body = json.loads(r.read())
    except urllib.error.HTTPError as e:
        code = e.code
        # Never echo the request headers: they carry the relay key.
        try:
            body = json.loads(e.read())
        except (ValueError, OSError):
            body = None
    except Exception as e:                                          # noqa: BLE001
        return {"anyDelivered": False, "detail": f"relay unreachable: {e}"}

    if not isinstance(body, dict) or not isinstance(body.get("sent"), list):
        # Carry the worker's OWN error text through. Throwing it away meant a
        # recipient typo, an oversize message or a missing key all logged the
        # same "unreadable reply" hourly, with the real reason discarded at the
        # one moment somebody needed it.
        why = (body or {}).get("error") if isinstance(body, dict) else None
        return {"anyDelivered": False, "delivered": [], "failed": [],
                "detail": f"relay {code or 200}: {why or 'unreadable reply'}"}
    delivered = [s.get("email") for s in body["sent"] if s.get("ok")]
    failed = [{"email": s.get("email"), "error": s.get("error")}
              for s in body["sent"] if not s.get("ok")]
    return {"anyDelivered": bool(delivered), "delivered": delivered,
            "failed": failed, "refused": body.get("refused") or []}


def log_readings(rows):
    os.makedirs(STATE_DIR, exist_ok=True)
    stamp = datetime.now().isoformat(timespec="seconds")
    with open(LEDGER, "a") as fh:
        for r in rows:
            fh.write(json.dumps({"at": stamp, "label": r["label"], "ok": r["ok"],
                                 "balanceGbp": r["balanceGbp"],
                                 "daysLeft": r["daysLeft"],
                                 # The meter is recorded so a silently dropped
                                 # identity check is visible in the ledger
                                 # rather than inert (CLAUDE.md: an invariant
                                 # with no control reads as a pass for ever).
                                 "meterLast4": r.get("meterLast4"),
                                 "problem": r["problem"]}) + "\n")


SENT_MARK = os.path.join(STATE_DIR, "sent.json")
# The hour by which Kevin hears SOMETHING, even if the sessions are down. A
# watcher that stays quiet because it could not read is indistinguishable from
# one reporting healthy meters, and the quiet morning is the one that costs a
# review.
DEGRADED_HOUR = 9
# Nothing sends before this hour. The cron fires hourly from 00:05, and a
# meter reading is not something anyone acts on at 2am; a DM at that hour
# teaches you to mute the channel.
EARLIEST_HOUR = 7


def read_sent_mark():
    try:
        with open(SENT_MARK) as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return {}


def write_sent_mark(kind, alarmed_labels=(), lost_labels=()):
    os.makedirs(STATE_DIR, exist_ok=True)
    tmp = SENT_MARK + ".tmp"
    with open(tmp, "w") as fh:
        json.dump({"date": datetime.now().strftime("%Y-%m-%d"), "kind": kind,
                   # Per FLAT. A single boolean gave the whole portfolio one
                   # alarm a day, so the second flat to empty stayed silent.
                   "alarmedLabels": sorted(set(alarmed_labels)),
                   "lostLabels": sorted(set(lost_labels)),
                   "at": datetime.now().isoformat(timespec="seconds")}, fh)
    # Rename, never truncate-then-write: the job-queue lock learned that the
    # hard way on 2 Sep 2026, when a reader caught the file mid-rewrite.
    os.replace(tmp, SENT_MARK)


def alarming_labels(rows, low_gbp, alarm_days=ALARM_DAYS_LEFT):
    """Which flats need topping up right now, by label.

    Per FLAT, not one boolean for the portfolio. The single `alarmed` flag meant
    Apartment 1 emptying at 10:00 used up the day's only alarm, and Apartment 2
    going off supply at 15:00 said nothing until 07:05 the next morning. Two
    flats, one alarm slot.
    """
    return sorted(r["label"] for r in rows if row_alarm(r, low_gbp, alarm_days))


def lost_sight_labels(rows):
    """Flats that were unreadable this tick.

    row_alarm returns False for a row that could not be read, so an unreadable
    meter cannot alarm at all. Once the morning message had gone, a session that
    lapsed at 08:00 hid a meter emptying at 14:00 for twenty-three hours while
    the job logged "worked" every hour.
    """
    return sorted(r["label"] for r in rows if not r["ok"])


def send_decision(already, complete, hour, alarm=False, alarmed=False, force=False,
                  new_alarms=(), lost_sight=()):
    """Send or hold, and why. Pure, so the hourly cadence is testable.

    `already` is what was sent TODAY: None, "degraded" or "full".
    `alarm`   a meter needs topping up right now.
    `alarmed` an alarm has already been sent today.

    TWO BUGS THIS SHAPE EXISTS FOR, both measured on 18 Sep 2026:

    1. The cron is `5 * * * *`, so the first tick of the day is 00:05, and the
       old gate sent the daily message THERE: at midnight, to a sleeping Roy,
       carrying a figure read at the lowest-usage hour of the day. Nothing may
       send before EARLIEST_HOUR now.

    2. The old gate held for the rest of the day once anything had been sent.
       A flat reading £14 at 07:05 and £0 by 18:00 was read hourly all day and
       never mentioned again. An ALARM now overrides the daily mark, once.
       That also rescues the case where a degraded morning is followed by a
       partial reading showing an empty meter.
    """
    if force:
        return "send", "forced"
    if hour < EARLIEST_HOUR:
        return "hold", f"before {EARLIEST_HOUR}:00; reading only, nobody acts on a meter at this hour"
    # A flat that has not alarmed today gets its own message, whatever else has
    # already been sent. `new_alarms` is the caller's per-flat list; `alarm` and
    # `alarmed` remain for the simple two-argument case and the tests.
    if new_alarms:
        return "send", "these flats need topping up and have not been reported today: " + ", ".join(new_alarms)
    if lost_sight:
        return "send", "lost sight of " + ", ".join(lost_sight) + "; a meter cannot be watched through a dead session"
    if alarm and not alarmed:
        return "send", "a meter needs topping up today"
    if already == "full":
        return "hold", "already sent today; this run was the session keepalive"
    if complete:
        return "send", "first full reading of the morning"
    if already == "degraded":
        return "hold", "degraded message already sent today; nothing new to add"
    if hour < DEGRADED_HOUR:
        return "hold", f"nothing readable yet, holding until {DEGRADED_HOUR}:00 before saying so"
    return "send", f"nothing readable by {DEGRADED_HOUR}:00, saying so rather than staying quiet"


def expected_accounts(cfg):
    """The accounts list, checked against the count the config declares.

    all([]) is True, so an empty or hand-trimmed accounts list used to produce a
    message with no flats in it, attention False, exit 0, and the day marked
    "full" — a flat could drop out of the watcher entirely with no signal. This
    is CLAUDE.md's rule that every count needs an expected number.
    """
    accounts = cfg.get("accounts") or []
    want = cfg.get("expectedAccounts")
    if want is not None and len(accounts) != want:
        raise SystemExit(f"ERROR: config declares {want} accounts but lists "
                         f"{len(accounts)}; refusing to report a partial portfolio")
    if not accounts:
        raise SystemExit("ERROR: no accounts in the config; nothing to watch")
    return accounts


def cmd_run(argv):
    """Runs HOURLY. Reads every time (which is what holds the session open),
    but sends at most one message a day, plus one alarm.

    Utilita's login lasts a rolling hour, so the read IS the keepalive; a
    single daily run would find itself signed out every morning. Sending is
    decoupled from reading, and send_decision() owns the whole policy.
    """
    cfg = load_config()
    accounts = expected_accounts(cfg)
    low = cfg.get("lowBalanceGbp", 10)
    alarm_days = cfg.get("alarmDaysLeft", ALARM_DAYS_LEFT)
    rows = [read_account(a) for a in accounts]
    log_readings(rows)
    text, attention, alarm = build_message(rows, low, alarm_days=alarm_days)
    print(text)

    if "--dry-run" in argv:
        print("\n[dry run: nothing sent]")
        return 0

    complete = bool(rows) and all(r["ok"] for r in rows)
    mark = read_sent_mark()
    today = datetime.now().strftime("%Y-%m-%d")
    fresh = mark.get("date") == today
    already = mark.get("kind") if fresh else None
    alarmed_before = set(mark.get("alarmedLabels") or []) if fresh else set()
    lost_before = set(mark.get("lostLabels") or []) if fresh else set()
    force = "--force" in argv

    alarming = alarming_labels(rows, low, alarm_days)
    lost = lost_sight_labels(rows)
    # Only flats not already reported today. Reporting the same flat hourly is
    # how a channel gets muted, which is the other half of the same failure.
    new_alarms = [l for l in alarming if l not in alarmed_before]
    # A flat we have lost sight of counts only once the day already had a full
    # message, otherwise the ordinary degraded path covers it.
    new_lost = [l for l in lost if l not in lost_before] if already == "full" else []

    verdict, why = send_decision(already, complete, datetime.now().hour,
                                 force=force, new_alarms=new_alarms,
                                 lost_sight=new_lost)
    if verdict == "hold":
        print("\n[" + why + "]")
        # A held tick that is nonetheless carrying a fault exits non-zero so
        # estate-status shows it. It used to return 0 unconditionally, so a
        # lapsed session read as "worked" every hour for a day.
        return 1 if attention else 0

    print("\n[sending: " + why + "]")
    result = send_slack(text, cfg["recipients"])
    print("\nslack:", "delivered" if result["anyDelivered"] else "FAILED",
          json.dumps(result)[:400])

    if result["anyDelivered"] and not force:
        # NOT on --force: a manual test send at 06:00 used to write the mark and
        # silence the real morning message.
        write_sent_mark("full" if complete else "degraded",
                        alarmed_labels=alarmed_before | set(alarming),
                        lost_labels=lost_before | set(lost))

    # A LOW BALANCE IS THE JOB WORKING, NOT A FAILURE.
    # job-queue.py maps a non-zero child exit to outcome "failed", which
    # estate-status.py renders as a Failed row and morning-digest.py lists under
    # failures. Exiting 1 on `attention` meant the watcher reported itself broken
    # on exactly the mornings a meter was genuinely low, which is how a red
    # light stops being read. So: a delivered message is a success. Only a
    # failed delivery, or a technical fault on a flat, is a failure.
    if not result["anyDelivered"]:
        return 1
    if result.get("failed"):
        print("some recipients did not receive it:", json.dumps(result["failed"]),
              file=sys.stderr)
        return 1
    return 1 if attention else 0


def cmd_read():
    cfg = load_config()
    rows = [read_account(a) for a in expected_accounts(cfg)]
    print(json.dumps(rows, indent=1))
    text, attention, alarm = build_message(
        rows, cfg.get("lowBalanceGbp", 10),
        alarm_days=cfg.get("alarmDaysLeft", ALARM_DAYS_LEFT))
    print("\n--- message ---\n" + text)
    print(f"\n[attention={attention} alarm={alarm}]")
    return 1 if attention else 0


def cmd_keepalive():
    """Touch both sessions so Utilita's rolling hour restarts. Reports, never silent."""
    cfg = load_config()
    out = []
    for a in expected_accounts(cfg):
        r = read_account(a)
        out.append({"label": r["label"], "signedIn": r["signedIn"], "problem": r["problem"]})
    print(json.dumps(out))
    return 0 if all(o["signedIn"] for o in out) else 1


SAMPLE_APT1 = """My energy
Apartment 1 Duckworth Building, FY8 1SQ
Balance
REFRESH
£20.26

5 days left

Electricity Top-up Number
9826003801209677811
OTHER CHARGES
£1350.60
"""

SAMPLE_APT2 = """My energy
Duckworth Building, FY8 1SQ
Balance
REFRESH
£34.37

More than a week left

Electricity Top-up Number
9826003801208182409
OTHER CHARGES
£957.92
"""


def selftest():
    bad = []

    def chk(name, want, got):
        if want != got:
            bad.append((name, want, got))

    def row(label="Apartment 1", ok=True, bal=None, gbp=None, days=None,
            problem=None, meter="7811", recognised=True):
        return {"label": label, "ok": ok, "problem": problem, "balance": bal,
                "balanceGbp": gbp, "daysLeft": days, "meterLast4": meter,
                "daysLeftRecognised": recognised}

    # ── the real pages ────────────────────────────────────────────────────
    a, b = parse_energy(SAMPLE_APT1), parse_energy(SAMPLE_APT2)
    chk("apt1 balance", 20.26, a["balanceGbp"])
    chk("apt1 days", "5 days left", a["daysLeft"])
    chk("apt1 meter", "9826003801209677811", a["topUpNumber"])
    chk("apt2 balance", 34.37, b["balanceGbp"])
    chk("apt2 days", "More than a week left", b["daysLeft"])
    chk("apt1 not refused", None, a["refused"])

    # ── OTHER CHARGES must NEVER become the balance ───────────────────────
    # Every shape below reported £1350.60 before the card-end fix (18 Sep 2026).
    unpainted = parse_energy(
        "My energy\nApartment 1 Duckworth Building, FY8 1SQ\nBalance\nREFRESH\n"
        "5 days left\nElectricity Top-up Number\n9826003801209677811\n"
        "OTHER CHARGES\n£1350.60\n")
    chk("balance tile unpainted -> no figure", None, unpainted["balanceGbp"])
    if not unpainted["refused"]:
        bad.append(("unpainted tile gives a reason", "a reason", None))

    placeholder = parse_energy("Balance\nREFRESH\n£--\nOTHER CHARGES\n£1350.60\n")
    chk("£-- placeholder -> no figure", None, placeholder["balanceGbp"])

    # An implausible figure is REPORTED with a flag, never refused: refusing
    # meant a genuine £620 was never shown and the job logged itself failed
    # hourly. The structural guards are what make OTHER CHARGES unreachable.
    high = parse_energy("Balance\nREFRESH\n£1350.60\n5 days left\n")
    chk("an implausible figure is still reported", 1350.60, high["balanceGbp"])
    chk("an implausible figure is flagged", True, high["implausible"])
    real = parse_energy("Balance\nREFRESH\n£620.00\nMore than a week left\n")
    chk("a genuine £620 is reported", 620.00, real["balanceGbp"])
    chk("a genuine £620 is not refused", None, real["refused"])
    normal = parse_energy("Balance\nREFRESH\n£20.26\n5 days left\n")
    chk("a normal balance is not flagged", False, normal["implausible"])

    # ── the money regex ───────────────────────────────────────────────────
    chk("a decimal comma is not thousands", None,
        parse_energy("Balance\nREFRESH\n£2,50\n1 day left\n")["balanceGbp"])
    chk("grouped thousands still parse", 1234.50,
        parse_energy("Balance\nREFRESH\n£1,234.50\n1 day left\n")["balanceGbp"])
    chk("a typographic minus parses as debt", -5.20,
        parse_energy("Balance\nREFRESH\n\u2212£5.20\nOff supply\n")["balanceGbp"])
    chk("pounds with no pence parse", 20.00,
        parse_energy("Balance\nREFRESH\n£20\n5 days left\n")["balanceGbp"])

    # ── ambiguity is refused, never guessed ──────────────────────────────
    two = parse_energy("Balance\nREFRESH\n50p\nTop up\n£20\n5 days left\n")
    chk("50p then £20 is not silently £20", None, two["balanceGbp"])
    two_amounts = parse_energy("Balance\nREFRESH\n£5.00\n£20.00\n5 days left\n")
    chk("two amounts in one card refuse", None, two_amounts["balanceGbp"])
    if "cannot tell which" not in (two_amounts["refused"] or ""):
        bad.append(("two amounts say why", "cannot tell which", two_amounts["refused"]))
    far = parse_energy("Balance\nREFRESH\na\nb\nc\nd\ne\nf\n£20.00\n")
    chk("a figure far below the heading is not the balance", None, far["balanceGbp"])

    # ── the days line survives a card-end SUBSTRING ──────────────────────
    # "usage" as a substring ended the card on "See your usage", which sat
    # above "Off supply", so an off-supply meter raised no alarm at all.
    seen = parse_energy("Balance\nREFRESH\n£12.40\nSee your usage\nOff supply\n"
                        "Electricity Top-up Number\n9826003801209677811\n")
    chk("days line survives a substring marker", "Off supply", seen["daysLeft"])
    chk("and it alarms", True, row_alarm(
        {"ok": True, "balanceGbp": 12.40, "daysLeft": seen["daysLeft"]}, 10))
    chk("an exact marker still ends the card", None,
        parse_energy("Balance\nREFRESH\nUsage\n£1350.60\n")["balanceGbp"])

    nav = parse_energy("Balance\nMy energy\nBalance\nREFRESH\n£20.26\n5 days left\n")
    chk("two balance cards -> refused", None, nav["balanceGbp"])
    if "cannot tell which" not in (nav["refused"] or ""):
        bad.append(("two cards says why", "cannot tell which", nav["refused"]))

    # ── a meter in debt parses, and alarms ────────────────────────────────
    debt = parse_energy("Balance\nREFRESH\n-£5.20\n\nOff supply\n"
                        "Electricity Top-up Number\n9826003801209677811\n"
                        "OTHER CHARGES\n£1350.60\n")
    chk("negative balance parses", -5.20, debt["balanceGbp"])
    chk("negative balance renders", "-£5.20", debt["balance"])
    chk("off supply carried", "Off supply", debt["daysLeft"])

    off = parse_energy("Balance\nREFRESH\n£0.00\n\nNo credit left\n")
    chk("empty meter", 0.0, off["balanceGbp"])
    chk("empty meter days", "No credit left", off["daysLeft"])

    # A reworded days line is carried verbatim, as the header promises, and
    # marked unrecognised rather than dropped.
    reworded = parse_energy("Balance\nREFRESH\n£8.00\nAbout 1 day left\n")
    chk("reworded days carried", "About 1 day left", reworded["daysLeft"])
    chk("reworded days flagged", False, reworded["daysLeftRecognised"])

    spaced = parse_energy("Balance\nREFRESH\n£8.00\n2 days left\n"
                          "Electricity Top-up Number\n9826 0038 0120 9677 811\n")
    chk("spaced meter number still read", "9826003801209677811", spaced["topUpNumber"])

    # ── DAYS LEFT is the primary trigger (Kevin, 18 Sep 2026) ─────────────
    # £20 lasts about five days, so the old £10 floor gave barely two and a
    # half days' notice. Too tight for a flat with paying guests in it.
    chk("5 days does not warn", False, row_alarm(row(bal="£20.12", gbp=20.12, days="5 days left"), 10))
    chk("4 days does not warn", False, row_alarm(row(bal="£16.00", gbp=16.00, days="4 days left"), 10))
    chk("3 days warns", True, row_alarm(row(bal="£12.00", gbp=12.00, days="3 days left"), 10))
    chk("2 days warns", True, row_alarm(row(bal="£8.00", gbp=8.00, days="2 days left"), 10))
    chk("1 day warns", True, row_alarm(row(bal="£4.00", gbp=4.00, days="1 day left"), 10))
    chk("0 days warns", True, row_alarm(row(bal="£0.20", gbp=0.20, days="0 days left"), 10))
    chk("more than a week never warns", False,
        row_alarm(row(bal="£34.30", gbp=34.30, days="More than a week left"), 10))
    # A healthy POUNDS figure no longer hides a short number of days: this is
    # the case the pounds-only rule got wrong.
    chk("£25 with 3 days still warns", True,
        row_alarm(row(bal="£25.00", gbp=25.00, days="3 days left"), 10))

    chk("days parsed from the line", 5, days_left_number("5 days left"))
    chk("a single day parses", 1, days_left_number("1 day left"))
    chk("a worded line gives no number", None, days_left_number("More than a week left"))
    chk("a missing line gives no number", None, days_left_number(None))

    # The pounds floor still stands alone when the page shows no days line.
    chk("the pounds floor alone still warns", True,
        row_alarm(row(bal="£4.10", gbp=4.10, days=None), 10))
    chk("and a healthy balance with no days line does not", False,
        row_alarm(row(bal="£34.30", gbp=34.30, days=None), 10))

    # The threshold is a parameter, not a constant buried in the rule.
    chk("a tighter threshold is respected", False,
        row_alarm(row(bal="£12.00", gbp=12.00, days="3 days left"), 10, alarm_days=2))
    chk("a looser threshold is respected", True,
        row_alarm(row(bal="£20.00", gbp=20.00, days="5 days left"), 10, alarm_days=5))

    # ── the alarm reads the days line, not only the number ────────────────
    chk("off supply alarms", True, row_alarm(row(bal="£1350.60", gbp=1350.60, days="Off supply"), 10))
    chk("less than a day alarms", True, row_alarm(row(bal="£12.40", gbp=12.40, days="Less than a day left"), 10))
    chk("no credit alarms", True, row_alarm(row(bal="£0.00", gbp=0.0, days="No credit left"), 10))
    chk("negative alarms", True, row_alarm(row(bal="-£5.20", gbp=-5.20, days="1 day left"), 10))
    chk("low balance alarms", True, row_alarm(row(bal="£4.10", gbp=4.10, days="1 day left"), 10))
    chk("healthy does not alarm", False, row_alarm(row(bal="£34.30", gbp=34.30, days="More than a week left"), 10))

    # ── the signed-in verdict is not a substring match ────────────────────
    chk("dashboard is signed in", True, signed_in("https://my.utilita.co.uk/energy", 0))
    chk("login with a returnUrl is NOT signed in", False,
        signed_in("https://my.utilita.co.uk/login?returnUrl=/energy", 0))
    chk("a password box is not signed in", False, signed_in("https://my.utilita.co.uk/energy", 1))

    # ── the meter gate ───────────────────────────────────────────────────
    A, B = "9826003801209677811", "9826003801208182409"
    if meter_problem(A, B) is None:
        bad.append(("meter mismatch not caught", "refusal", None))
    if "…2409" not in (meter_problem(A, B) or ""):
        bad.append(("meter refusal names the meter seen", "…2409", "missing"))
    chk("matching meter passes", None, meter_problem(A, A))
    chk("missing meter is not a mismatch", None, meter_problem(A, None))
    chk("unpinned flat is not a mismatch", None, meter_problem(None, B))

    # ── the cadence ──────────────────────────────────────────────────────
    cases = [
        # (already, complete, hour, alarm, alarmed) -> verdict
        ((None, True, 0, False, False), "hold"),      # 00:05 tick must NOT send
        ((None, True, 6, False, False), "hold"),      # still too early
        ((None, True, 7, False, False), "send"),      # the morning message
        (("full", True, 9, False, False), "hold"),    # done for today
        (("full", False, 14, False, False), "hold"),  # a later fault does not re-send
        (("full", True, 18, True, False), "send"),    # a meter went low AFTER the message
        (("full", True, 18, True, True), "hold"),     # but only once
        ((None, True, 2, True, False), "hold"),       # an alarm still waits for 07:00
        ((None, False, 8, False, False), "hold"),     # nothing yet, before 09:00
        ((None, False, 9, False, False), "send"),     # nothing by 09:00: say so
        (("degraded", False, 12, False, False), "hold"),
        (("degraded", True, 12, False, False), "send"),
        (("degraded", False, 12, True, False), "send"),  # partial, but a meter is empty
    ]
    for (already, complete, hour, alarm, alarmed), want in cases:
        got, _ = send_decision(already, complete, hour, alarm=alarm, alarmed=alarmed)
        if got != want:
            bad.append((f"send_decision({already!r},{complete},h={hour},alarm={alarm},alarmed={alarmed})",
                        want, got))
    chk("--force overrides everything", "send",
        send_decision("full", True, 3, force=True)[0])

    # ── the message ──────────────────────────────────────────────────────
    msg, att, alarm = build_message(
        [row(ok=False, problem="SIGN-IN NEEDED", meter=None),
         row(label="Apartment 2", bal="£34.37", gbp=34.37,
             days="More than a week left", meter="2409")], 10)
    if "SIGN-IN NEEDED" not in msg or "£0.00" in msg or not att:
        bad.append(("lapsed session message", "SIGN-IN NEEDED + attention", msg[:80]))
    if "Robot sign-in" not in msg:
        bad.append(("lapsed session lacks the fix", "Robot sign-in line", "missing"))
    if "…2409" not in msg:
        bad.append(("the meter is shown so a dropped check is visible", "…2409", "missing"))

    nometer, _, _ = build_message([row(bal="£20.00", gbp=20.0, days="5 days left", meter=None)], 10)
    if "meter not shown" not in nometer:
        bad.append(("a missing meter says so", "meter not shown", nometer[:80]))

    lowmsg, _, low_alarm = build_message([row(bal="£4.10", gbp=4.10, days="1 day left")], 10)
    if "top up today" not in lowmsg or not low_alarm:
        bad.append(("low balance flag", "flagged", lowmsg[:60]))
    finemsg, fine_att, fine_alarm = build_message(
        [row(bal="£34.37", gbp=34.37, days="More than a week left")], 10)
    if "top up today" in finemsg or fine_alarm or fine_att:
        bad.append(("healthy balance flagged anyway", "clean", finemsg[:60]))

    # ── per-flat alarms, and losing sight of a meter ──────────────────────
    two_rows = [row(label="Apartment 1", bal="£0.50", gbp=0.50, days="Less than a day left"),
                row(label="Apartment 2", bal="£34.30", gbp=34.30, days="More than a week left")]
    chk("only the empty flat alarms", ["Apartment 1"], alarming_labels(two_rows, 10))
    chk("a healthy pair alarms for nobody", [], alarming_labels(
        [row(label="Apartment 1", bal="£20", gbp=20.0, days="5 days left"),
         row(label="Apartment 2", bal="£34.30", gbp=34.30, days="More than a week left")], 10))

    # The bug: one boolean gave the whole portfolio ONE alarm a day, so the
    # second flat to empty said nothing until the next morning.
    chk("a flat not yet reported today still sends", "send",
        send_decision("full", True, 15, new_alarms=["Apartment 2"])[0])
    chk("a flat already reported today does not re-send", "hold",
        send_decision("full", True, 15, new_alarms=[])[0])
    chk("an alarm still waits for the morning", "hold",
        send_decision(None, True, 3, new_alarms=["Apartment 1"])[0])

    chk("losing sight of a flat is reported", "send",
        send_decision("full", False, 14, lost_sight=["Apartment 1"])[0])
    chk("lost_sight_labels finds the unreadable flat", ["Apartment 1"],
        lost_sight_labels([row(label="Apartment 1", ok=False, problem="SIGN-IN NEEDED"),
                           row(label="Apartment 2", bal="£34.30", gbp=34.30, days="5 days left")]))

    # ── the message says when a control is missing ────────────────────────
    nodays, nodays_att, _ = build_message(
        [row(bal="£12.40", gbp=12.40, days=None)], 10)
    if "days left not shown" not in nodays or not nodays_att:
        bad.append(("a missing days line says so", "days left not shown", nodays[:90]))
    highmsg, high_att, _ = build_message(
        [dict(row(bal="£1,350.60", gbp=1350.60, days="5 days left"), implausible=True)], 10)
    if "check this" not in highmsg or not high_att:
        bad.append(("an implausible figure is flagged in the message", "check this", highmsg[:90]))

    # ── the portfolio count has a control ────────────────────────────────
    try:
        expected_accounts({"accounts": [], "expectedAccounts": 2})
        bad.append(("an empty accounts list is refused", "SystemExit", "accepted"))
    except SystemExit:
        pass
    try:
        expected_accounts({"accounts": [{"label": "one"}], "expectedAccounts": 2})
        bad.append(("a short accounts list is refused", "SystemExit", "accepted"))
    except SystemExit:
        pass
    chk("two of two is accepted", 2,
        len(expected_accounts({"accounts": [{"label": "a"}, {"label": "b"}],
                               "expectedAccounts": 2})))

    if bad:
        for name, want, got in bad:
            print(f"FAIL {name}: wanted {want!r}, got {got!r}")
        return 1
    print("selftest OK")
    return 0


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "run":
        return cmd_run(sys.argv[2:])
    if cmd == "read":
        return cmd_read()
    if cmd == "keepalive":
        return cmd_keepalive()
    if cmd == "selftest":
        return selftest()
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main())
