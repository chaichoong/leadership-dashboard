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
meter is empty.

Usage
  utilita-balance.py run               HOURLY job. Always reads (which holds the
                                       session open), sends at most once a day
  utilita-balance.py run --dry-run     read and print the message, send nothing
  utilita-balance.py run --force       send now regardless of the daily mark
  utilita-balance.py read              read both, print the report, send nothing
  utilita-balance.py keepalive         touch both sessions so the hour restarts
  utilita-balance.py selftest          offline checks on the parser and gates

Exit code is 1 when a send FAILED or when the message it sent contains something
needing attention, so the launchd wrapper records a real failure. An hourly run
that deliberately stays quiet exits 0: alarming every hour about a problem
already reported once is how a channel gets muted.
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
    out = subprocess.run(
        ["bash", "-lc", "ls -d /Users/*/.nvm/versions/node/*/bin/node | sort -V | tail -1"],
        capture_output=True, text=True)
    found = (out.stdout or "").strip()
    return found or "node"


def load_config():
    if not os.path.exists(CONFIG):
        sys.exit(f"ERROR: no Utilita config at {CONFIG}")
    with open(CONFIG) as fh:
        return json.load(fh)


def parse_energy(text):
    """Pull balance, days-left and top-up number out of the /energy page text.

    Kept a pure function so the tests read the real one instead of a copy.

    The balance is the FIRST money line after 'Balance', never simply the first
    money line on the page: 'OTHER CHARGES' sits a few lines below it and read
    £1350.60 on Apartment 1, which would have been reported as the credit on
    the meter.
    """
    lines = [l.strip() for l in (text or "").split("\n")]
    lines = [l for l in lines if l]
    out = {"balance": None, "balanceGbp": None, "daysLeft": None, "topUpNumber": None}

    money = re.compile(r"^£\s?([\d,]+(?:\.\d{1,2})?)$")
    try:
        start = next(i for i, l in enumerate(lines) if l.lower() == "balance")
    except StopIteration:
        start = None

    if start is not None:
        for l in lines[start + 1:start + 8]:
            m = money.match(l)
            if m:
                out["balance"] = l
                out["balanceGbp"] = float(m.group(1).replace(",", ""))
                break
        for l in lines[start + 1:start + 12]:
            if any(re.match(p, l, re.I) for p in DAYS_PATTERNS):
                out["daysLeft"] = l
                break

    for i, l in enumerate(lines):
        if "top-up number" in l.lower():
            for nxt in lines[i + 1:i + 3]:
                if re.fullmatch(r"\d{10,25}", nxt):
                    out["topUpNumber"] = nxt
                    break
            if out["topUpNumber"]:
                break
    return out


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


def read_account(acct, node=None):
    """One flat. Returns a row that always states what it knows and what it does not."""
    node = node or node_bin()
    row = {"label": acct["label"], "profile": acct["profile"], "ok": False,
           "signedIn": None, "balance": None, "balanceGbp": None,
           "daysLeft": None, "problem": None}
    try:
        proc = subprocess.run(
            [node, os.path.join(REPO, "scripts", "agent-browser.js"), "read",
             "--url", ENERGY_URL, "--profile", acct["profile"],
             "--wait", "4500", "--max-text", "1200"],
            capture_output=True, text=True, timeout=180)
    except subprocess.TimeoutExpired:
        row["problem"] = "the page did not load in time"
        return row
    if proc.returncode != 0:
        row["problem"] = "could not open the page (" + (proc.stderr or "").strip()[:80] + ")"
        return row

    last = [l for l in (proc.stdout or "").strip().split("\n") if l.strip()]
    try:
        data = json.loads(last[-1]) if last else {}
    except (ValueError, IndexError):
        row["problem"] = "the browser returned something unreadable"
        return row

    url = data.get("url") or ""
    row["signedIn"] = bool(data.get("passwordFields") == 0 and "/energy" in url)
    if not row["signedIn"]:
        row["problem"] = "SIGN-IN NEEDED"
        return row

    got = parse_energy(data.get("text") or "")
    # The meter, not the address, decides which flat this is.
    mismatch = meter_problem(acct.get("topUpNumber"), got["topUpNumber"])
    if mismatch:
        row["problem"] = mismatch
        return row
    if got["balance"] is None:
        row["problem"] = "signed in, but the balance was not on the page"
        return row

    row.update({"ok": True, "balance": got["balance"], "balanceGbp": got["balanceGbp"],
                "daysLeft": got["daysLeft"], "meterLast4": (got["topUpNumber"] or "")[-4:]})
    return row


def build_message(rows, low_gbp, when=None):
    when = when or datetime.now()
    head = "*Duckworth electric, " + when.strftime("%a %-d %b") + "*"
    body, attention = [], False
    for r in rows:
        if r["ok"]:
            days = (" — " + r["daysLeft"]) if r["daysLeft"] else ""
            low = ""
            if r["balanceGbp"] is not None and r["balanceGbp"] < low_gbp:
                low, attention = "  ⚠️ *top up today*", True
            body.append("*" + r["label"] + "*: " + r["balance"] + days + low)
        else:
            attention = True
            body.append("*" + r["label"] + "*: _" + (r["problem"] or "no reading") + "_")
    if any(r.get("problem") == "SIGN-IN NEEDED" for r in rows):
        body.append("")
        body.append("_Open the Robot sign-in app on the Desktop to put that right._")
    body.append("")
    body.append("_Read at " + when.strftime("%H:%M") + "._")
    return head + "\n" + "\n".join(body), attention


def send_slack(text, recipients):
    if not os.path.exists(RELAY_KEY_PATH):
        return False, f"no relay key at {RELAY_KEY_PATH}"
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
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return True, json.loads(r.read())
    except urllib.error.HTTPError as e:
        # Never echo the request headers: they carry the relay key.
        return False, f"relay {e.code}: {e.read().decode()[:200]}"
    except Exception as e:                                          # noqa: BLE001
        return False, f"relay unreachable: {e}"


def log_readings(rows):
    os.makedirs(STATE_DIR, exist_ok=True)
    stamp = datetime.now().isoformat(timespec="seconds")
    with open(LEDGER, "a") as fh:
        for r in rows:
            fh.write(json.dumps({"at": stamp, "label": r["label"], "ok": r["ok"],
                                 "balanceGbp": r["balanceGbp"],
                                 "daysLeft": r["daysLeft"],
                                 "problem": r["problem"]}) + "\n")


SENT_MARK = os.path.join(STATE_DIR, "sent.json")
# The hour by which Kevin hears SOMETHING, even if the sessions are down. A
# watcher that stays quiet because it could not read is indistinguishable from
# one reporting healthy meters, and the quiet morning is the one that costs a
# review.
DEGRADED_HOUR = 9


def read_sent_mark():
    try:
        with open(SENT_MARK) as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return {}


def write_sent_mark(kind):
    os.makedirs(STATE_DIR, exist_ok=True)
    tmp = SENT_MARK + ".tmp"
    with open(tmp, "w") as fh:
        json.dump({"date": datetime.now().strftime("%Y-%m-%d"), "kind": kind,
                   "at": datetime.now().isoformat(timespec="seconds")}, fh)
    # Rename, never truncate-then-write: the job-queue lock learned that the
    # hard way on 2 Sep 2026, when a reader caught the file mid-rewrite.
    os.replace(tmp, SENT_MARK)


def send_decision(already, complete, hour, force=False):
    """Send or hold, and why. Pure, so the hourly cadence is testable.

    `already` is what was sent TODAY: None, "degraded" or "full".
    Returns ("send"|"hold", reason).
    """
    if force:
        return "send", "forced"
    if already == "full":
        return "hold", "already sent today; this run was the session keepalive"
    if complete:
        return "send", "first full reading of the day"
    if already == "degraded":
        return "hold", "degraded message already sent today; nothing new to add"
    if hour < DEGRADED_HOUR:
        return "hold", f"nothing readable yet, holding until {DEGRADED_HOUR}:00 before saying so"
    return "send", f"nothing readable by {DEGRADED_HOUR}:00, saying so rather than staying quiet"


def cmd_run(argv):
    """Runs HOURLY. Reads every time (which is what holds the session open),
    but sends at most one message a day.

    Utilita's login lasts a rolling hour, so the read IS the keepalive; a
    single daily run would find itself signed out every morning. Sending is
    therefore decoupled from reading:

      * first run of the day with a figure for every flat  -> send, done
      * nothing readable yet, before 09:00                 -> stay quiet, retry
      * nothing readable by 09:00                          -> send what we know
      * a full reading arrives later, after a degraded one -> send the upgrade

    So a bad morning costs two messages at most, and a good one costs one.
    """
    cfg = load_config()
    rows = [read_account(a) for a in cfg["accounts"]]
    log_readings(rows)
    text, attention = build_message(rows, cfg.get("lowBalanceGbp", 10))
    print(text)

    if "--dry-run" in argv:
        print("\n[dry run: nothing sent]")
        return 1 if attention else 0

    complete = all(r["ok"] for r in rows)
    mark = read_sent_mark()
    today = datetime.now().strftime("%Y-%m-%d")
    already = mark.get("kind") if mark.get("date") == today else None
    force = "--force" in argv

    verdict, why = send_decision(already, complete, datetime.now().hour, force)
    if verdict == "hold":
        print("\n[" + why + "]")
        return 0

    sent, detail = send_slack(text, cfg["recipients"])
    print("\nslack:", "sent" if sent else "FAILED", json.dumps(detail)[:300])
    if sent and not force:
        write_sent_mark("full" if complete else "degraded")
    # A failed send is always a failure. A sent message about a real problem is
    # also one, so the digest sees it; a clean sent message is not.
    return 0 if (sent and not attention) else 1


def cmd_read():
    cfg = load_config()
    rows = [read_account(a) for a in cfg["accounts"]]
    print(json.dumps(rows, indent=1))
    text, attention = build_message(rows, cfg.get("lowBalanceGbp", 10))
    print("\n--- message ---\n" + text)
    return 1 if attention else 0


def cmd_keepalive():
    """Touch both sessions so Utilita's rolling hour restarts. Reports, never silent."""
    cfg = load_config()
    out = []
    for a in cfg["accounts"]:
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

    a = parse_energy(SAMPLE_APT1)
    if a["balanceGbp"] != 20.26:
        bad.append(("apt1 balance", 20.26, a["balanceGbp"]))
    if a["daysLeft"] != "5 days left":
        bad.append(("apt1 days", "5 days left", a["daysLeft"]))
    if a["topUpNumber"] != "9826003801209677811":
        bad.append(("apt1 meter", "…7811", a["topUpNumber"]))

    b = parse_energy(SAMPLE_APT2)
    if b["balanceGbp"] != 34.37:
        bad.append(("apt2 balance", 34.37, b["balanceGbp"]))
    if b["daysLeft"] != "More than a week left":
        bad.append(("apt2 days", "More than a week left", b["daysLeft"]))

    # The bug this guards: OTHER CHARGES (£1350.60) must never be read as the
    # balance. Both flats carry a four-figure one, so a first-money-line parse
    # would have reported it as credit on the meter.
    if a["balanceGbp"] == 1350.60 or b["balanceGbp"] == 957.92:
        bad.append(("other charges leaked into balance", "no", "yes"))

    # A page with no Balance heading yields nothing rather than a wrong number.
    empty = parse_energy("My energy\nOTHER CHARGES\n£1350.60\n")
    if empty["balanceGbp"] is not None:
        bad.append(("no-balance page", None, empty["balanceGbp"]))

    # An empty meter still parses, and its phrasing survives.
    off = parse_energy("Balance\nREFRESH\n£0.00\n\nNo credit left\n")
    if off["balanceGbp"] != 0.0 or off["daysLeft"] != "No credit left":
        bad.append(("empty meter", "0.0/No credit left",
                    f"{off['balanceGbp']}/{off['daysLeft']}"))

    # The meter gate: a different number refuses, a missing one does not cry wolf.
    if meter_problem("9826003801209677811", "9826003801208182409") is None:
        bad.append(("meter mismatch not caught", "refusal", None))
    if "…2409" not in (meter_problem("9826003801209677811", "9826003801208182409") or ""):
        bad.append(("meter refusal names the meter seen", "…2409", "missing"))
    if meter_problem("9826003801209677811", "9826003801209677811") is not None:
        bad.append(("matching meter refused", None, "refusal"))
    if meter_problem("9826003801209677811", None) is not None:
        bad.append(("missing meter treated as mismatch", None, "refusal"))
    if meter_problem(None, "9826003801208182409") is not None:
        bad.append(("unpinned flat treated as mismatch", None, "refusal"))

    # The hourly cadence: one message a day, and never a silent bad morning.
    cases = [
        # (already, complete, hour) -> verdict
        ((None,     True,  6),  "send"),   # first full reading, any hour
        (("full",   True,  9),  "hold"),   # done for today
        (("full",   False, 9),  "hold"),   # a later failure does not re-send
        ((None,     False, 7),  "hold"),   # nothing yet, early: wait for the session
        ((None,     False, 9),  "send"),   # nothing by 09:00: say so
        ((None,     False, 14), "send"),   # still nothing later: say so
        (("degraded", False, 12), "hold"), # already warned, nothing new
        (("degraded", True,  12), "send"), # signed in since: send the real figures
    ]
    for (already, complete, hour), want in cases:
        got, _why = send_decision(already, complete, hour)
        if got != want:
            bad.append((f"send_decision({already!r},{complete},{hour})", want, got))
    if send_decision("full", True, 9, force=True)[0] != "send":
        bad.append(("--force ignores the daily mark", "send", "hold"))

    # A lapsed session says SIGN-IN NEEDED and reports no figure at all.
    msg, att = build_message(
        [{"label": "Apartment 1", "ok": False, "problem": "SIGN-IN NEEDED",
          "balance": None, "balanceGbp": None, "daysLeft": None},
         {"label": "Apartment 2", "ok": True, "problem": None, "balance": "£34.37",
          "balanceGbp": 34.37, "daysLeft": "More than a week left"}], 10)
    if "SIGN-IN NEEDED" not in msg or "£0.00" in msg or not att:
        bad.append(("lapsed session message", "SIGN-IN NEEDED + attention", msg[:80]))
    if "Robot sign-in" not in msg:
        bad.append(("lapsed session lacks the fix", "Robot sign-in line", "missing"))

    # A low balance is flagged, a healthy one is not.
    low, att_low = build_message(
        [{"label": "Apartment 1", "ok": True, "problem": None, "balance": "£4.10",
          "balanceGbp": 4.10, "daysLeft": "1 day left"}], 10)
    if "top up today" not in low or not att_low:
        bad.append(("low balance flag", "flagged", low[:60]))
    fine, att_fine = build_message(
        [{"label": "Apartment 2", "ok": True, "problem": None, "balance": "£34.37",
          "balanceGbp": 34.37, "daysLeft": "More than a week left"}], 10)
    if "top up today" in fine or att_fine:
        bad.append(("healthy balance flagged anyway", "clean", fine[:60]))

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
