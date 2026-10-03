#!/usr/bin/env python3
"""session-keepalive.py — keep the robot signed in, and say so when it is not.

WHY (Kevin, 4 Sep 2026: "can you build that so that's in place as well")
Most of the sites the robot works in keep a login alive for weeks IF the site
is visited; an unused session quietly expires, and the first the estate hears
of it is a robot writing SIGN-IN NEEDED in the middle of a job. Once a day this
visits every login site that can hold a session (the allowlist entries with a
loginUrl and no shortSession flag), which refreshes the cookie, and asks
agent-browser.js `session` whether the robot is signed in:

    signed in   — the session walk landed on a page of the site itself
    signed out  — a password box, One Login's pages, or still at the door
    unknown     — the walk could not run; NOT treated as signed out

The verdict is the browser lane's own (sessionVerdict, after the site's
sessionWalk clicks), the same one the pickup run and the submit gate read.
Until 15 Sep 2026 this file judged a `read` of the login URL by its path and
text, and any /login path read as signed out: Spotify for Creators, whose door
shows "Continue with Spotify" whether or not the cookie is live, raised a
sign-in task every morning with a cookie good to 2027.

A signed-out site becomes ONE task in Kevin's queue in the standard form
("SIGN-IN NEEDED: <site> (<url>)"), parked until the morning message, owned
by the Task Manager and marked KEEPALIVE CHECK so `signin-done` closes it the
moment he has signed in. Never a second task while one is open (the create
gate and signin-waiting both check). GOV.UK and HMRC are skipped on purpose:
their sessions cannot be held and need his code every time.

No task for a site that did not stay signed in after his last two sign-ins,
or his last four for a site that has held one before (2 Oct 2026,
signin_hold.py): EDF had 15 of these cards, Amazon 7 and BW Legal's portal,
which has no account yet, one every morning. The site is still visited, so the
first sign-in that holds puts it back on the daily list, and a job that needs
it asks for the sign-in when it needs it.

Usage:  session-keepalive.py run [--dry-run]     |  session-keepalive.py selftest
State:  ~/knowledge-os/logs/session-keepalive/status.json (latest verdict per site)
"""
import glob
import json
import os
import shutil
import subprocess
import sys
import urllib.parse
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import signin_hold  # noqa: E402

try:
    from zoneinfo import ZoneInfo
    LONDON = ZoneInfo("Europe/London")
except Exception:                                   # noqa: BLE001
    LONDON = None

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATE_DIR = os.path.expanduser("~/knowledge-os/logs/session-keepalive")
STATUS = os.path.join(STATE_DIR, "status.json")
TASK_MANAGER = "rec1hYELb4zS8pjjO"      # Team Members row of the Task Manager agent
F = {                                   # Tasks field ids (drift-tested in agent-dispatch.py's AF)
    "name": "fldgFjGBw6bTKJFCD", "status": "fldx4qCw17UfrKpaN", "dueDate": "fld7XP8w8kbxfETV4",
    "teamMember": "flduCtmQGpOA4eWaj", "sentForApprovalBy": "fld30Yw8SWYVp049g",
    "agentOutput": "fldzswp8fx6PqpLQ5", "taskType": "fldZ2moDV2041Sobc", "notes": "fldR7apBzSp3oxFxz",
    "deferredUntil": "fldJ9IHS1yxwYzYSN", "description": "fldRGhBQViKZKtkQ6",
}


def now_london():
    return datetime.now(LONDON) if LONDON else datetime.now()


def node_bin():
    node = (os.environ.get("AGENT_NODE_BIN") or shutil.which("node")
            or (sorted(glob.glob(os.path.expanduser("~/.nvm/versions/node/*/bin/node"))) or [None])[-1])
    if not node:
        raise RuntimeError("node not found: no AGENT_NODE_BIN, not on PATH, no nvm install")
    return node


def load_sites():
    r = subprocess.run([node_bin(), os.path.join(REPO, "scripts", "agent-browser.js"), "sites"],
                       capture_output=True, text=True, check=True)
    return json.loads(r.stdout)


def keepalive_sites(sites):
    """Login sites that can hold a session: loginUrl present, not shortSession."""
    return {h: v for h, v in sites.items() if v.get("login") and v.get("loginUrl") and not v.get("shortSession")}


def session_state(result):
    """'signed-in' | 'signed-out' | 'bot-check' | 'unknown' from an agent-browser `session` result.

    Pure, so the selftest can pin it. The verdict is the browser lane's
    (`signedIn`, decided in code by sessionVerdict after the site's walk);
    this file no longer judges a page. No verdict is unknown, never signed out.
    """
    if not result or result.get("error") or "signedIn" not in result:
        return "unknown"
    # A bot check is not a lapsed login: a sign-in card for it could never
    # close (Cloudflare, review 25 Sep 2026). Reported, never filed.
    if result.get("botCheck"):
        return "bot-check"
    # The robot's own refresh (Amazon) could not run, or its second read failed:
    # nobody learned whether the site would have let it back in. Unknown, never a card.
    refresh = str(result.get("selfRefresh") or "")
    if not result.get("signedIn") and (refresh.startswith("not run") or "second read failed" in refresh):
        return "unknown"
    return "signed-in" if result.get("signedIn") else "signed-out"


def read_site(host, entry):
    cmd = [node_bin(), os.path.join(REPO, "scripts", "agent-browser.js"), "session", "--site", host]
    try:
        # 300: a site the robot signs itself back in to (Amazon) walks twice around a 20-second window.
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
    except subprocess.TimeoutExpired:
        return {"error": "timeout"}
    if r.returncode != 0:
        return {"error": (r.stderr or r.stdout or "read failed").strip()[:300]}
    try:
        return json.loads(r.stdout)
    except ValueError:
        return {"error": "unreadable output"}


def not_holding_note(host, entry, events=None):
    """Why no task is raised for a signed-out HOST, or '' when one should be.

    `events` is the browser ledger read AFTER this run's own check of the
    site, so that check counts toward the newest sign-in."""
    url_host = urllib.parse.urlsplit(entry.get("loginUrl") or "").hostname
    unheld = signin_hold.unheld_signins(signin_hold.load_events() if events is None else events, host, url_host)
    if not unheld:
        return ""
    days = [(d.astimezone(LONDON) if LONDON else d).strftime("%d %b").lstrip("0") for d in unheld]
    return "not raised: signed out again after the sign-ins of %s" % " and ".join([", ".join(days[:-1]), days[-1]])


def already_waiting(host):
    """Is there an open SIGN-IN NEEDED task for this site already?"""
    # --no-walk: this run has just walked the site itself; a second walk would
    # fight it for the one robot profile, and the listing is all it needs.
    r = subprocess.run([sys.executable, os.path.join(REPO, "scripts", "agent-dispatch.py"), "signin-waiting", "--no-walk"],
                       capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError("signin-waiting failed: " + (r.stderr or "")[:200])
    return any(g.get("host") == host for g in json.loads(r.stdout).get("sites", []))


def signin_task_fields(host, entry, when):
    label = entry.get("label") or host
    url = entry["loginUrl"]
    stamp = when.strftime("%d %b %Y %H:%M")
    # Park it for the NEXT 08:00 message: a run before 08:00 (the scheduled
    # 06:40) means today's message; a run after it means tomorrow's. Found on
    # the first live dry-run: "tomorrow" from a 06:40 run skipped a whole day.
    parked_for = when if when.hour < 8 else when + timedelta(days=1)
    tomorrow = parked_for.strftime("%Y-%m-%d")
    output = (f"SIGN-IN NEEDED: {label} ({url})\n\n"
              f"The robot's login to {label} has lapsed (daily session check, {stamp}). "
              "Nothing is blocked yet; signing in once puts the session back so the next "
              "job on this site does not stall.\n\n"
              "**Carrying this out will involve:** Nothing until you sign in; the moment you do, "
              "the robot's session is back and this closes itself.")
    return {
        F["name"]: f"SIGN-IN: {label} session lapsed",
        F["description"]: f"Daily session keep-alive found {label} signed out on {stamp}.",
        F["status"]: "Approval",
        F["dueDate"]: when.strftime("%Y-%m-%d"),
        F["deferredUntil"]: tomorrow,
        F["teamMember"]: [TASK_MANAGER],
        F["sentForApprovalBy"]: [TASK_MANAGER],
        F["taskType"]: "Admin",
        F["agentOutput"]: output,
        F["notes"]: f"[{stamp} — session-keepalive] KEEPALIVE CHECK: {label} ({host}) signed out. "
                    "Parked until the morning message; closes on sign-in.",
    }


def create_task(fields, dry_run):
    if dry_run:
        return {"dryRun": True}
    # --force: the duplicate gate's fuzzy pass folded six "SIGN-IN: <site>
    # session lapsed" tasks into one on the first live run (4 Sep 2026), so
    # five sites vanished from the morning list. One task per site is the
    # point; `already_waiting` is the dedupe, per host, before we get here.
    r = subprocess.run([sys.executable, os.path.join(REPO, "scripts", "create-agent-task.py"), "create",
                        "--force", "--fields-json", json.dumps(fields)], capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError("create-agent-task failed: " + (r.stderr or r.stdout)[:300])
    return {"created": True, "out": r.stdout.strip()[:200]}


def cmd_run(dry_run=False):
    sites = keepalive_sites(load_sites())
    when = now_london()
    report = {"at": when.isoformat(), "sites": {}}
    for host, entry in sites.items():
        # One site's failure must never stop the rest being checked, and an
        # unchecked site must read as unknown, never as fine.
        try:
            res = read_site(host, entry)
        except Exception as e:                              # noqa: BLE001
            res = {"error": str(e)[:300]}
        state = session_state(res)
        row = {"label": entry.get("label"), "state": state, "landedOn": str(res.get("url") or "")[:120]}
        if state == "signed-out":
            # A rule that cannot be worked out never silences the ask: the task is raised as before.
            try:
                note = not_holding_note(host, entry)
            except Exception as e:                          # noqa: BLE001
                note, row["notHoldingError"] = "", str(e)[:200]
            try:
                if note:
                    row["notHolding"], row["task"] = True, note
                elif already_waiting(host):
                    row["task"] = "already waiting"
                else:
                    row["task"] = create_task(signin_task_fields(host, entry, when), dry_run)
            except Exception as e:                          # noqa: BLE001
                row["task"] = {"error": str(e)[:200]}
        elif state == "unknown":
            row["error"] = res.get("error", "")
        report["sites"][host] = row
    os.makedirs(STATE_DIR, exist_ok=True)
    tmp = STATUS + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(report, fh, indent=1)
    os.replace(tmp, STATUS)
    counts = {k: sum(1 for r in report["sites"].values() if r["state"] == k) for k in ("signed-in", "signed-out", "bot-check", "unknown")}
    print(json.dumps({"at": report["at"], "counts": counts,
                      "signedOut": [r["label"] for r in report["sites"].values() if r["state"] == "signed-out"],
                      "signInWhenNeeded": [r["label"] for r in report["sites"].values() if r.get("notHolding")],
                      "unknown": [r["label"] for r in report["sites"].values() if r["state"] == "unknown"]}, indent=1))
    # An all-unknown run means the browser lane is broken, not that everything is fine.
    if report["sites"] and counts["unknown"] == len(report["sites"]):
        print("ERROR: every site read as unknown — the browser lane failed, nothing was checked", file=sys.stderr)
        return 1
    return 0


def selftest():
    cases = [
        # The real `session` results of 15 Sep 2026: Spotify's door after its
        # walk (signed in), EDF's password form (signed out), a walk that
        # could not run, and a result with no verdict at all.
        ({"site": "creators.spotify.com", "signedIn": True, "url": "https://creators.spotify.com/home/show/6hL5", "passwordFields": 0,
          "walked": [{"label": "Continue with Spotify", "found": True}]}, "signed-in"),
        ({"site": "www.edfenergy.com", "signedIn": False, "url": "https://www.edfenergy.com/myaccount/login", "passwordFields": 1}, "signed-out"),
        ({"site": "dash.cloudflare.com", "signedIn": False, "botCheck": True, "url": "https://dash.cloudflare.com/", "passwordFields": 0}, "bot-check"),
        ({"site": "app.pingen.com", "signedIn": True, "url": "https://app.pingen.com/organisation/x/dashboard", "passwordFields": 0}, "signed-in"),
        ({"error": "timeout"}, "unknown"),
        ({"url": "https://app.pingen.com/login", "passwordFields": 0, "text": "Log in"}, "unknown"),
        ({}, "unknown"),
        # Amazon's own refresh could not run (2 Oct 2026): unknown, not a lapsed login.
        ({"site": "www.amazon.co.uk", "signedIn": False, "url": "https://www.amazon.co.uk/ap/signin", "selfRefresh": "not run: the profile is in use"}, "unknown"),
        ({"site": "www.amazon.co.uk", "signedIn": False, "url": "https://www.amazon.co.uk/ap/signin", "selfRefresh": "ran, still signed out"}, "signed-out"),
    ]
    bad = [(c, want, session_state(c)) for c, want in cases if session_state(c) != want]
    sites = {"a": {"login": True, "loginUrl": "https://a/", "shortSession": True},
             "b": {"login": True, "loginUrl": "https://b/"}, "c": {"login": True}, "d": {"login": False, "loginUrl": "x"}}
    if list(keepalive_sites(sites)) != ["b"]:
        bad.append(("keepalive_sites", ["b"], list(keepalive_sites(sites))))
    f = signin_task_fields("app.pingen.com", {"label": "Pingen (letters)", "loginUrl": "https://app.pingen.com/"},
                           datetime(2026, 9, 4, 6, 40))
    if not f[F["agentOutput"]].startswith("SIGN-IN NEEDED: Pingen (letters) (https://app.pingen.com/)"):
        bad.append(("task output line", "SIGN-IN NEEDED first", f[F["agentOutput"]][:60]))
    if f[F["deferredUntil"]] != "2026-09-04" or "KEEPALIVE CHECK:" not in f[F["notes"]]:
        bad.append(("task parking (06:40 run -> today's 08:00)", "2026-09-04 + KEEPALIVE CHECK", (f[F["deferredUntil"]], f[F["notes"]][:40])))
    late = signin_task_fields("app.pingen.com", {"label": "Pingen (letters)", "loginUrl": "https://app.pingen.com/"},
                              datetime(2026, 9, 4, 15, 50))
    if late[F["deferredUntil"]] != "2026-09-05":
        bad.append(("task parking (afternoon run -> tomorrow's 08:00)", "2026-09-05", late[F["deferredUntil"]]))
    # EDF's real ledger lines, 30 Sep to 2 Oct 2026: signed out the morning after each sign-in.
    edf = {"loginUrl": "https://www.edfenergy.com/myaccount/login"}
    lines = [{"at": "2026-09-30T08:24:12Z", "cmd": "login", "host": "www.edfenergy.com", "profile": "default"},
             {"at": "2026-10-01T05:40:30Z", "cmd": "session", "site": "www.edfenergy.com", "signedIn": False, "signinPage": True, "profile": "default"},
             {"at": "2026-10-01T08:48:10Z", "cmd": "login", "host": "www.edfenergy.com", "profile": "default"},
             {"at": "2026-10-02T05:40:30Z", "cmd": "session", "site": "www.edfenergy.com", "signedIn": False, "signinPage": True, "profile": "default"}]
    if not_holding_note("www.edfenergy.com", edf, lines) != "not raised: signed out again after the sign-ins of 30 Sep and 1 Oct":
        bad.append(("two sign-ins that did not hold", "no task, with the reason", not_holding_note("www.edfenergy.com", edf, lines)))
    if not_holding_note("www.edfenergy.com", edf, lines[2:]) != "":
        bad.append(("one sign-in that did not hold", "a task as before", not_holding_note("www.edfenergy.com", edf, lines[2:])))
    if bad:
        for b in bad:
            print("FAIL", b, file=sys.stderr)
        return 1
    print(f"selftest OK ({len(cases) + 6} checks)")
    return 0


if __name__ == "__main__":
    a = sys.argv[1:]
    if not a or a[0] not in ("run", "selftest"):
        sys.exit("usage: session-keepalive.py run [--dry-run] | selftest")
    sys.exit(selftest() if a[0] == "selftest" else cmd_run(dry_run="--dry-run" in a))
