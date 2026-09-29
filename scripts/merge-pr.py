#!/usr/bin/env python3
"""The one way an interactive session merges a PR: test the merge result, walk
the pages it touches, and only then merge.

WHY THIS EXISTS (29 Sep 2026)
-----------------------------
405 of the 472 changes that reached main in the 30 days to 29 Sep 2026 arrived
by `gh pr merge --squash` from an interactive Claude session. Nothing tested
that route. scripts/pre-push gates only a direct push to main, and no GitHub
workflow runs the tests, so the route almost everything took was the one route
with no gate. The robot fixer already had a proven gate (scripts/fixer-merge.py):
it builds origin/main with the PR merged in, in a throwaway worktree, and runs
vitest and the Playwright suite THERE. This script puts interactive merges
through the same gate, adds a walk of the pages the PR touches, and
scripts/merge-guard.py (a PreToolUse hook) refuses the bare `gh pr merge` that
went around it.

WHAT IT DOES
  1. Refuses a PR that is not OPEN, targets a branch other than main, or is a
     draft (a draft may still be dry-run).
  2. Builds the merge result with fixer-merge.py's build_merge_result and reads
     from THAT tree what was tested: the origin/main commit it was built on
     (first parent, or ORIG_HEAD after a fast-forward), the PR head (second
     parent, or HEAD), and the files the PR changes (git diff base...head).
     refs/fixer/pr-N is not trusted for this: the queue fixer can overwrite it.
  3. Runs vitest, then tests/sync-invariants/, in that tree (the same two
     commands and cwd rule as fixer-merge.py's run_gate, but each in its own
     process group, stopped with SIGINT then SIGKILL, so a timeout or an
     interrupt leaves no workers, browsers or Playwright web server behind).
     Vitest red = refused, never retried. Browser red = the tests that failed
     are re-run ONCE in the same tree (--last-failed). Green on the retry is a
     pass, reported as browser.flakyRetried; red again is refused. Measured 29
     Sep 2026: with 16 test processes on the Mac, 18 of 505 Playwright tests
     failed, and all 149 tests in those 13 files passed alone. A gate that
     refuses on load teaches people to go around it.
  4. Asks scripts/affected-pages.py (in the merge result) which pages the PR
     touches. None: no walk. Some or all: serves the merge result on 127.0.0.1
     (proved to be THIS tree by a random nonce file) and runs
     scripts/prod-walk.js against it (--only for some).
  5. Every page that is FAIL or WARN in the merge result is walked again on the
     LIVE site, and their REASONS are compared, not their status: console
     errors, value leaks, the page error, the entry gate, an HTTP error, a
     blank or unrendered panel, and the boot errors, each normalised (scheme and
     host, query string and :line:col stripped). A reason seen in the merge
     result and not live is a NEW failure: refused. So is a FAIL here against a
     WARN or PASS live, and a higher error count here than live. Reasons also seen live are
     main's own problems: reported as alreadyBrokenLive, never blocking (a page
     broken on main must not block unrelated merges). Failed requests are
     reported, never blocking. When only the boot errors are in question, the
     live re-walk boots with --only one walked page. A page whose only new
     reason is a gate (still loading, a sign-in screen) is walked once more
     locally first: gates come and go with timing. A page main does not have
     yet is judged alone (FAIL blocks, WARN is reported). A list prod-walk cut
     short at 50 cannot be compared: cannot judge. A walk that cannot run or
     cannot be read is "cannot judge": refused. Green on nothing is not green.
  6. Just before merging, reads origin/main again. If main moved during the
     gate and changed a file this PR changes, it refuses ("run it again");
     otherwise it merges and reports mainMovedBy.
  7. Merges with `gh pr merge N --squash --match-head-commit <tested head>`, so
     a push after the gate cannot slip in untested, and confirms MERGED through
     `gh pr view` (gh exits non-zero when a worktree holds main even though the
     merge worked). It does NOT pass --delete-branch: that runs `git checkout
     main` in the worktree it is run from, and a later `worktree.sh done
     --force` then deleted local main (3 and 4 Sep 2026). The REMOTE head
     branch is deleted through the API instead; a failed delete is reported and
     never changes "merged".
  Protected paths (fixer-merge.py's list) do not block here: Kevin approves
  interactive work in session. They are reported as protectedPathsTouched.
  The merge tree, the local server and any worktree an interrupted build left
  are removed on every exit, Ctrl-C and SIGTERM included.

Usage:
    python3 scripts/merge-pr.py --pr 123             # gate, then merge if green
    python3 scripts/merge-pr.py --pr 123 --dry-run   # gate only, never merges
    Run it with run_in_background: a run takes 5 to 15 minutes. Progress lines
    go to stderr; ONE JSON result goes to stdout.
Exit: 0 merged, or --dry-run green
      1 refused: a red gate, or the gate cannot judge
      2 the gate itself broke, or bad arguments
Each run appends a line to ~/knowledge-os/logs/merge-gate.log (outside the
repo, which is PUBLIC): UTC time, PR, head, MERGED|REFUSED|DRYRUN-GREEN|
DRYRUN-RED|BROKE, why, flaky tests retried. Never reads or prints the Airtable
token: prod-walk.js reads it itself. Guarded by tests/merge-pr.test.js.
"""

import argparse
import glob
import importlib.util
import json
import os
import re
import secrets
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
LIVE = "https://app.operationsdirector.co.uk/"
# prod-walk.js hard-stops itself at 560 s and prints what it walked, so our
# timeout must be later, or its partial result is lost to our kill.
WALK_TIMEOUT = 600
RETRY_TIMEOUT = 900
SUITE_TIMEOUT = 1800        # per suite, as fixer-merge.py's run_gate allows
PLAYWRIGHT_GRACE = 20       # seconds between SIGINT and SIGKILL for a test run
AFFECTED_TIMEOUT = 120
SERVER_START_SECONDS = 15
NONCE_FILE = "merge-gate-nonce.txt"
PAGE_ID = re.compile(r"^[A-Za-z0-9_.-]+$")
STATUSES = ("PASS", "WARN", "FAIL")
MIN_CHARS = 40              # prod-walk.js: a panel shorter than this is blank
T0 = time.time()

_FM = None


def fixer():
    """scripts/fixer-merge.py, loaded by path (its name has a hyphen). Never
    edited from here: it is on its own protected list."""
    global _FM
    if _FM is None:
        spec = importlib.util.spec_from_file_location(
            "fixer_merge", os.path.join(HERE, "fixer-merge.py"))
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        _FM = mod
    return _FM


def progress(msg):
    print("[merge-pr %4ds] %s" % (time.time() - T0, msg), file=sys.stderr, flush=True)


def tail(text, n=400):
    return (text or "").strip()[-n:]


def run(args, cwd=None, timeout=120, stdin=None, env=None):
    # REPO is read at CALL time, not bound as a default, so a test can point
    # the module at a scratch directory (the fixer-merge.py lesson).
    return subprocess.run(args, cwd=cwd or REPO, capture_output=True, text=True,
                          timeout=timeout, input=stdin, env=env)


def run_group(args, cwd, timeout, env=None, first=signal.SIGTERM, grace=5, port=None):
    """A command in its own process group, so a timeout or an interrupt also
    stops what it started (a browser, test workers). (code|None, out, err, timedOut).
    `first` is the signal it gets before SIGKILL; `port`, when given, is a web
    server port swept afterwards (see sweep_port)."""
    p = subprocess.Popen(args, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                         text=True, start_new_session=True, env=env)
    try:
        out, err = p.communicate(timeout=timeout)
        return p.returncode, out, err, False
    except subprocess.TimeoutExpired:
        stop_group(p, first, grace)
        if port:
            sweep_port(port)
        try:
            out, err = p.communicate(timeout=10)
        except subprocess.TimeoutExpired:     # something outside the group holds the pipe
            out, err = "", ""
        return None, out, err, True
    except BaseException:
        stop_group(p, first, grace)
        raise
    finally:
        if port:
            sweep_port(port)


def stop_group(p, first=signal.SIGTERM, grace=5):
    """Send `first` to the whole group, wait up to `grace` seconds for it to go,
    then SIGKILL whatever is left. Playwright wants SIGINT (its Ctrl-C path is
    the one that stops the web server it started)."""
    if p is None:
        return
    pgid = p.pid

    def alive():
        p.poll()                      # reap our own child, or a zombie reads as alive
        try:
            os.killpg(pgid, 0)
            return True
        except (ProcessLookupError, PermissionError):
            return False

    if not alive():
        return
    try:
        os.killpg(pgid, first)
    except ProcessLookupError:
        return
    deadline = time.time() + grace
    while time.time() < deadline:
        if not alive():
            return
        time.sleep(0.1)
    try:
        os.killpg(pgid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    try:
        p.wait(timeout=5)
    except subprocess.TimeoutExpired:
        progress("process group %d did not die after SIGKILL" % pgid)


def sweep_port(port):
    """Playwright starts its web server DETACHED, in its own process group, so
    killing the run's group can leave it holding the port for ever. Stop any
    Python web server still listening on the run's port. Nothing else is touched."""
    try:
        r = subprocess.run(["lsof", "-nP", "-iTCP:%d" % port, "-sTCP:LISTEN", "-t"],
                           capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired) as e:
        progress("could not check port %d for a leftover web server: %s" % (port, e))
        return
    for pid in sorted(set((r.stdout or "").split())):
        try:
            cmd = subprocess.run(["ps", "-o", "command=", "-p", pid], capture_output=True,
                                 text=True, timeout=10).stdout or ""
        except (OSError, subprocess.TimeoutExpired):
            continue
        if "http.server" not in cmd and "HTTPServer" not in cmd:
            continue
        progress("stopping a web server left on port %d (pid %s)" % (port, pid))
        for sig in (signal.SIGTERM, signal.SIGKILL):
            try:
                os.kill(int(pid), sig)
            except (ProcessLookupError, PermissionError, ValueError):
                break
            for _ in range(30):
                try:
                    os.kill(int(pid), 0)
                except (ProcessLookupError, PermissionError):
                    break
                time.sleep(0.1)
            else:
                continue
            break


def run_suites(tree):
    """vitest, then the browser suite, both run IN the merge tree (the cwd rule
    fixer-merge.py's run_gate follows), each in its own process group: that
    run_gate uses subprocess.run, which on a timeout or an interrupt kills only
    npx and leaves the workers and browsers running. (ok, out, browser port)."""
    out = {"testedTree": tree}
    code, so, se, to = run_group(["npx", "vitest", "run", "--allowOnly=false"], tree, SUITE_TIMEOUT,
                                 first=signal.SIGINT, grace=PLAYWRIGHT_GRACE)
    out["vitest"] = {"ok": code == 0, "tail": tail(so or se)}
    if to:
        out["vitest"]["timedOut"] = True
    if not out["vitest"]["ok"]:
        return False, out, None
    # Pinned, so this run's .last-run.json is known to be test-results/run-<port>/
    # and its web server can be swept by port.
    port = free_port()
    env = dict(os.environ, PLAYWRIGHT_PORT=str(port))
    code, so, se, to = run_group(["npx", "playwright", "test", "tests/sync-invariants/",
                                  "--forbid-only", "--reporter=dot"], tree, SUITE_TIMEOUT, env=env,
                                 first=signal.SIGINT, grace=PLAYWRIGHT_GRACE, port=port)
    out["browser"] = {"ok": code == 0, "tail": tail(so or se)}
    if to:
        out["browser"]["timedOut"] = True
    return out["browser"]["ok"], out, port


# ─── WHY A PAGE FAILED, IN A FORM TWO SITES CAN SHARE ─────────────────
#
# The merge result is served from http://127.0.0.1:<port>/ and the live app
# from https://app.operationsdirector.co.uk/, so the same error reads
# differently on each. Strip what differs by site, keep what differs by bug.

_URL_HOST = re.compile(r"\b(?:https?|wss?)://[^/\s)'\"]+")
_QUERY = re.compile(r"\?[^\s)'\"]*")
_LINE_COL = re.compile(r":\d+(?::\d+)?(?=[\s)'\"]|$)")
# Python's server says "status of 404 (File not found)", GitHub Pages "(Not Found)".
_STATUS_TEXT = re.compile(r"status of (\d+) \([^)]*\)")


def norm(text):
    t = _URL_HOST.sub("", str(text))
    t = _QUERY.sub("", t)
    t = _LINE_COL.sub("", t)
    t = _STATUS_TEXT.sub(r"status of \1", t)
    return re.sub(r"\s+", " ", t).strip()


def page_reasons(p):
    """The blocking reasons one walked page shows. failedRequests are left out on
    purpose (reported, never blocking): they are the noisiest signal, and a
    broken resource also raises a console error, which is in here."""
    out = set()
    for e in p.get("consoleErrors") or []:
        out.add("console: " + norm(e))
    for e in p.get("leaks") or []:
        out.add("leak: " + norm(e))
    for e in p.get("softLeaks") or []:
        out.add("soft leak: " + norm(e))
    if p.get("error"):
        out.add("error: " + norm(p["error"]))
    if p.get("gate"):
        out.add("gate: " + norm(p["gate"]))
    status = p.get("httpStatus")
    if isinstance(status, int) and status >= 400:
        out.add("http %d" % status)
    chars = p.get("chars")
    if isinstance(chars, int) and chars < MIN_CHARS and not p.get("error"):
        out.add("blank: under %d characters" % MIN_CHARS)
    if p.get("rendered") is False or (p.get("status") == "FAIL" and not out):
        # prod-walk.js prints `rendered` (29 Sep 2026). A hidden panel still has
        # innerText, so without it a panel that never showed, failing on the same
        # console error live has, passed as main's own problem. A FAIL with no
        # stated reason from an older prod-walk is still read as not rendered.
        out.add("not rendered")
    return out


def _count(p, key, lists):
    """The DISTINCT entries prod-walk listed, never its own `key` count.

    prod-walk's count includes repeats, and a page that polls repeats the same
    error a different number of times on each walk, so comparing it would refuse
    healthy PRs (29 Sep 2026). The lists hold every distinct entry up to 50, and
    a list that hit 50 is judged separately as cannot judge. `key` stays in the
    signature so the callers name what they are counting."""
    return sum(len(p.get(k) or []) for k in lists)


def new_reasons(here, there):
    """What the merge result shows on a page that the live site does not."""
    new = page_reasons(here) - page_reasons(there)
    # A FAIL is never excused by a WARN or a PASS live, whatever the reasons
    # say: a panel that never renders but still reads "Loading..." shares the
    # live page's gate reason and would otherwise pass as main's own problem.
    if here.get("status") == "FAIL" and there.get("status") != "FAIL":
        new.add("status: FAIL here, %s live" % there.get("status"))
    # The same error twice (two call sites) is one reason once normalised, so
    # the counts decide what the sets cannot.
    for label, key, lists in (("console errors", "consoleErrorCount", ("consoleErrors",)),
                              ("leaks", "leakCount", ("leaks", "softLeaks"))):
        a, b = _count(here, key, lists), _count(there, key, lists)
        if a > b:
            new.add("%s: %d here, %d live" % (label, a, b))
    return new


def boot_reasons(result):
    return {"boot: " + norm(e) for e in (result or {}).get("bootErrors") or []}


def boot_count(result):
    return _count(result or {}, "bootErrorCount", ("bootErrors",))


def request_reasons(p):
    return {norm(e) for e in p.get("failedRequests") or []}


def is_gate(reason):
    return reason.startswith("gate: ")


# ─── THE DECISION (pure: no git, no GitHub, no browser) ───────────────
#
# walk is None when the walk stage was never reached, else a dict:
#   {"scope": "none"}                                  nothing to walk
#   {"scope": ..., "error": "..."}                     could not walk = cannot judge
#   {"scope": "some"|"all", "requested": [ids], "exit": int|None,
#    "timedOut": bool, "result": prod-walk's JSON or None}
# live is None when no re-check ran, else the same shape as a walk run, with
# "requested" = the ids it was asked to walk. regate is the local re-walk of
# the pages whose only new reason was a gate, same shape. main_ids is the set
# of PAGE_REGISTRY ids main had at the tested base, or None when unreadable.

def untrusted(run_, requested=None):
    """Why a walk run cannot be trusted, or None when it can."""
    if run_.get("error"):
        return run_["error"]
    if run_.get("timedOut"):
        return "the walk ran past its %d-minute limit" % (WALK_TIMEOUT // 60)
    res = run_.get("result")
    if not isinstance(res, dict):
        return "the walk printed no readable result"
    if res.get("ran") is not True:
        return "the walk did not run: %s" % str(res.get("reason") or "no reason given")[:200]
    code = run_.get("exit")
    if code not in (0, 1):
        return "the walk exited %s" % code
    if "hard stop" in str(res.get("reason") or "").lower():
        return "the walk hit its hard stop, so later pages were never walked"
    pages = res.get("pages")
    if not isinstance(pages, list) or not pages:
        return "the walk reported no pages"
    if any(not isinstance(p, dict) or p.get("status") not in STATUSES for p in pages):
        return "the walk reported a page with no PASS, WARN or FAIL status"
    if code == 1 and not any(p["status"] == "FAIL" for p in pages):
        return "the walk exited 1 with no failing page"
    unreached = [str(p.get("id")) for p in pages
                 if str(p.get("error") or "").startswith("not reached")]
    if unreached:
        return "pages never reached: %s" % ", ".join(unreached)
    # prod-walk.js reports an --only id missing from PAGE_REGISTRY as a FAIL. It
    # fails live too, so without this it would pass as "already broken live"
    # while the page was never walked at all: a stale page map, never a pass.
    unknown = [str(p.get("id")) for p in pages
               if str(p.get("error") or "").startswith("not in PAGE_REGISTRY")]
    if unknown:
        return "pages the walk does not know (stale page map?): %s" % ", ".join(unknown)
    if requested:
        seen = {p.get("id") for p in pages}
        missing = [i for i in requested if i not in seen]
        if missing:
            return "pages asked for but not walked: %s" % ", ".join(missing)
    return None


def recheck_ids(walk, main_ids=None):
    """The ids to walk again on the live site: every FAIL or WARN page main
    already has (a page new in this PR is not on the live site to compare, so it
    is judged alone). When only the boot errors need a live comparison, one page
    main has, since the live re-walk always boots. [] when there is nothing to
    compare, or the walk cannot be trusted anyway."""
    if not walk or walk.get("scope") not in ("some", "all"):
        return []
    if untrusted(walk, walk.get("requested") if walk.get("scope") == "some" else None):
        return []
    pages = walk["result"]["pages"]
    on_main = [p["id"] for p in pages if main_ids is None or p["id"] in main_ids]
    ids = sorted({p["id"] for p in pages if p["status"] in ("FAIL", "WARN") and p["id"] in on_main})
    if not ids and (boot_reasons(walk["result"]) or boot_count(walk["result"])):
        ids = [on_main[0]] if on_main else [sorted(main_ids)[0]]
    return ids


def walk_findings(walk, live, regate=None, main_ids=None):
    out = {"recheck": [], "newFailures": [], "newReasons": {}, "alreadyBrokenLive": [],
           "requestFailures": [], "newPages": [], "newPagesWarn": [], "gateOnly": [],
           "cannot": None}
    if walk is None:
        out["cannot"] = "the page walk did not run"
        return out
    scope = walk.get("scope")
    if walk.get("error"):
        out["cannot"] = walk["error"]
        return out
    if scope == "none":
        return out
    if scope not in ("some", "all"):
        out["cannot"] = "unknown walk scope %r" % scope
        return out
    why = untrusted(walk, walk.get("requested") if scope == "some" else None)
    if why:
        out["cannot"] = "the walk of the merge result: " + why
        return out
    result = walk["result"]
    local = {p["id"]: p for p in result["pages"]}

    # A page main does not have yet cannot be compared with the live site: it is
    # judged alone. FAIL blocks; WARN is reported.
    if main_ids is not None:
        for pid, p in local.items():
            if pid in main_ids:
                continue
            out["newPages"].append(pid)
            if p["status"] == "FAIL":
                out["newFailures"].append(pid)
                out["newReasons"][pid] = ["a page new in this PR FAILS in the merge result: "
                                          + "; ".join(sorted(page_reasons(p)))[:300]]
            elif p["status"] == "WARN":
                out["newPagesWarn"].append(pid)

    out["recheck"] = recheck_ids(walk, main_ids)
    if not out["recheck"]:
        return out
    if live is None:
        out["cannot"] = "pages failed or warned and the live site was not re-checked"
        return out
    why = untrusted(live, out["recheck"])
    if why:
        out["cannot"] = "the live re-check: " + why
        return out
    if result.get("bootTruncated") or live["result"].get("bootTruncated"):
        out["cannot"] = "a boot error list hit prod-walk's limit, so the two cannot be compared"
        return out
    live_pages = {p["id"]: p for p in live["result"]["pages"]}

    judged = {}
    for pid in out["recheck"]:
        here = local.get(pid)
        if here is None or here["status"] == "PASS":
            continue          # a page walked live only to boot the site
        there = live_pages[pid]
        if here.get("truncated") or there.get("truncated"):
            out["cannot"] = "%s: an error list hit prod-walk's limit, so the two cannot be compared" % pid
            return out
        new = new_reasons(here, there)
        if new and all(is_gate(r) for r in new):
            out["gateOnly"].append(pid)
        judged[pid] = (here, there, new)

    # A gate (still loading, a sign-in screen) is the one reason that comes and
    # goes with timing, so a page whose ONLY new reason is a gate gets one more
    # local walk before it can block.
    if out["gateOnly"] and regate is not None:
        why = untrusted(regate, out["gateOnly"])
        if why:
            out["cannot"] = "the second local walk of %s: %s" % (", ".join(out["gateOnly"]), why)
            return out
        again = {p["id"]: p for p in regate["result"]["pages"]}
        for pid in out["gateOnly"]:
            _, there, _ = judged[pid]
            judged[pid] = (again[pid], there, new_reasons(again[pid], there))

    for pid, (here, there, new) in judged.items():
        if new:
            out["newFailures"].append(pid)
            out["newReasons"][pid] = sorted(new)
        elif page_reasons(here):
            out["alreadyBrokenLive"].append(pid)
        reqs = request_reasons(here) - request_reasons(there)
        if reqs:
            out["requestFailures"].append({"id": pid, "onlyInMergeResult": sorted(reqs)})

    new_boot = boot_reasons(result) - boot_reasons(live["result"])
    a, b = boot_count(result), boot_count(live["result"])
    if a > b:
        new_boot.add("boot errors: %d here, %d live" % (a, b))
    if new_boot:
        out["newFailures"].append("(boot)")
        out["newReasons"]["(boot)"] = sorted(new_boot)
    return out


def verdict(gate_ok, walk, live, regate=None, main_ids=None):
    """(merge?, why). Everything the gate saw, reduced to one answer."""
    if not gate_ok:
        return False, "the test gate is RED on the merge result (vitest or the browser suite)"
    f = walk_findings(walk, live, regate, main_ids)
    if f["cannot"]:
        return False, "cannot judge: " + f["cannot"]
    if f["newFailures"]:
        detail = "; ".join("%s: %s" % (pid, " | ".join(f["newReasons"][pid])[:200])
                           for pid in f["newFailures"])
        return False, ("the merge result shows %d new failure(s) the live site does not: %s"
                       % (len(f["newFailures"]), detail))
    if walk.get("scope") == "none":
        return True, "tests green on the merge result; the PR touches no page, so no walk"
    notes = []
    if f["alreadyBrokenLive"]:
        notes.append("%d page(s) show the same problems on the live site, so main already "
                     "has them: %s" % (len(f["alreadyBrokenLive"]), ", ".join(f["alreadyBrokenLive"])))
    if f["newPagesWarn"]:
        notes.append("new page(s) WARN, reported: %s" % ", ".join(f["newPagesWarn"]))
    if notes:
        return True, "tests green and nothing new; " + "; ".join(notes)
    return True, "tests green and every page the PR touches walks clean on the merge result"


def walk_summary(walk, live, regate=None, main_ids=None):
    if walk is None:
        return None
    f = walk_findings(walk, live, regate, main_ids)
    res = walk.get("result") if isinstance(walk.get("result"), dict) else {}
    pages = [{"id": p.get("id"), "status": p.get("status"),
              **({"error": str(p.get("error"))[:160]} if p.get("error") else {})}
             for p in (res.get("pages") or []) if isinstance(p, dict)]

    def brief(r):
        if r is None:
            return None
        return {"requested": r.get("requested"), "exit": r.get("exit"),
                "error": r.get("error") or untrusted(r, r.get("requested")),
                "seconds": r.get("seconds")}

    return {
        "scope": walk.get("scope"),
        "requested": walk.get("requested") or [],
        "pages": pages,
        "counts": res.get("counts"),
        "writesBlocked": res.get("writesBlocked"),
        "bootErrors": res.get("bootErrors") or [],
        "mainRegistryRead": main_ids is not None,
        "recheckedLive": f["recheck"],
        "newFailures": f["newFailures"],
        "newReasons": f["newReasons"],
        "alreadyBrokenLive": f["alreadyBrokenLive"],
        "newPages": f["newPages"],
        "newPagesWarn": f["newPagesWarn"],
        "gateOnlyRewalked": f["gateOnly"] if regate is not None else [],
        "requestFailures": f["requestFailures"],
        "cannotJudge": f["cannot"],
        "liveRecheck": brief(live),
        "localRewalk": brief(regate),
        "error": walk.get("error"),
        "affectedBy": (walk.get("affected") or {}).get("files", [])[:40],
        "seconds": walk.get("seconds"),
    }


# ─── WHAT WAS TESTED, READ FROM THE TREE ITSELF ───────────────────────

def tree_shas(tree):
    """(base, head, error): the origin/main commit the tree was built on and the
    PR head merged into it. A merge commit's parents say it directly. A PR that
    fast-forwards main leaves no merge commit: HEAD is the PR head and git kept
    the pre-merge HEAD (origin/main) as ORIG_HEAD."""
    r = run(["git", "rev-list", "--parents", "-n", "1", "HEAD"], cwd=tree, timeout=30)
    parts = (r.stdout or "").split()
    if r.returncode != 0 or not parts:
        return None, None, "cannot read the merge tree's HEAD: %s" % tail(r.stderr, 200)
    if len(parts) == 3:
        return parts[1], parts[2], None
    if len(parts) > 3:
        return None, None, "the merge tree's HEAD has %d parents" % (len(parts) - 1)
    o = run(["git", "rev-parse", "--verify", "-q", "ORIG_HEAD"], cwd=tree, timeout=30)
    base = (o.stdout or "").strip()
    if o.returncode != 0 or not base:
        return None, None, "cannot tell which origin/main commit the tree was built on"
    return base, parts[0], None


def tree_files(tree, base, head):
    """The files the PR changes, from the tree. --no-renames lists both sides of
    a rename, so a page file moved away still counts as touched."""
    r = run(["git", "diff", "--name-only", "--no-renames", "%s...%s" % (base, head)],
            cwd=tree, timeout=60)
    if r.returncode != 0:
        return None, "cannot list the PR's files in the merge tree: %s" % tail(r.stderr, 200)
    return [f for f in (r.stdout or "").splitlines() if f.strip()], None


def main_check(base, files):
    """Has origin/main moved since the tree was built, and onto this PR's files?
    Returns {"refuse": why|None, "mainMovedBy": text|None, "mainNow": sha}."""
    r = run(["git", "ls-remote", "origin", "refs/heads/main"], timeout=60)
    now = (r.stdout or "").split()[0] if (r.stdout or "").split() else ""
    if r.returncode != 0 or not now:
        return {"refuse": "cannot read origin/main before merging: %s" % tail(r.stderr, 200)}
    if now == base:
        return {"refuse": None, "mainMovedBy": None, "mainNow": now}
    f = run(["git", "fetch", "origin", "main", "--quiet"], timeout=120)
    if f.returncode != 0:
        return {"refuse": "main moved during the gate and cannot be fetched: %s" % tail(f.stderr, 200)}
    anc = run(["git", "merge-base", "--is-ancestor", base, now], timeout=30)
    if anc.returncode != 0:
        return {"refuse": "main was rewritten during the gate (%s is no longer under it); "
                          "run it again" % base[:8]}
    n = run(["git", "rev-list", "--count", "%s..%s" % (base, now)], timeout=30)
    d = run(["git", "diff", "--name-only", "--no-renames", base, now], timeout=60)
    if n.returncode != 0 or d.returncode != 0:
        return {"refuse": "cannot read what changed on main during the gate"}
    overlap = sorted(set(d.stdout.split()) & set(files))
    count = (n.stdout or "?").strip()
    if overlap:
        return {"refuse": "main changed the same files during the gate, run it again: %s"
                          % ", ".join(overlap[:10])}
    return {"refuse": None, "mainNow": now,
            "mainMovedBy": "%s commits, other files only, not re-tested" % count}


# ─── THE STAGES ───────────────────────────────────────────────────────

def pr_facts(pr):
    fields = ("state,isDraft,headRefOid,title,baseRefName,headRefName,"
              "headRepository,isCrossRepository")
    try:
        r = run(["gh", "pr", "view", str(pr), "--json", fields], timeout=60)
    except (OSError, subprocess.TimeoutExpired) as e:
        return None, "cannot run gh: %s" % e
    if r.returncode != 0:
        return None, "cannot read PR #%d: %s" % (pr, tail(r.stderr or r.stdout, 200))
    try:
        facts = json.loads(r.stdout or "")
    except json.JSONDecodeError:
        return None, "gh gave no JSON for PR #%d" % pr
    if not isinstance(facts, dict):
        return None, "gh gave no JSON object for PR #%d" % pr
    return facts, None


def spec_names(suite, trail=()):
    """{test id: (outcome, "file › describe › title")} from a Playwright JSON
    report. The outcome is Playwright's own per-test status: "expected" is a
    pass. spec.ok is NOT used: it is true for a skipped test too."""
    out = {}
    here = trail + ((suite.get("title"),) if suite.get("title") else ())
    for spec in suite.get("specs") or []:
        statuses = [t.get("status") for t in spec.get("tests") or []]
        if not statuses:
            outcome = "no result"
        elif "skipped" in statuses:
            outcome = "skipped"
        elif all(s == "expected" for s in statuses):
            outcome = "expected"
        else:
            outcome = next(s for s in statuses if s != "expected") or "unexpected"
        out[spec.get("id")] = (outcome, " › ".join(here + (spec.get("title") or "",)))
    for child in suite.get("suites") or []:
        out.update(spec_names(child, here))
    return out


def retry_browser(tree, first_port):
    """Re-run ONLY the browser tests that failed, once, in the same tree.
    (green?, info). playwright.config.js writes each run's .last-run.json under
    test-results/run-<PORT>/ with a fresh port per run, so a plain --last-failed
    retry finds no file and silently runs the WHOLE suite. The failed ids are
    read from the first run's file and seeded into the retry's own folder."""
    last = os.path.join(tree, "test-results", "run-%s" % first_port, ".last-run.json")
    if not first_port or not os.path.isfile(last):
        return False, {"why": "no .last-run.json from the first browser run, so which tests failed is unknown"}
    try:
        with open(last) as fh:
            first = json.load(fh)
        failed = first.get("failedTests") or []
    except (OSError, ValueError, AttributeError) as e:
        return False, {"why": "cannot read the first run's .last-run.json: %s" % e}
    # An interrupted or timed-out run lists only the tests that failed BEFORE the
    # cut; everything after it never ran. Retrying that short list and calling it
    # green would merge a suite that mostly never ran (third review, 29 Sep 2026).
    if first.get("status") != "failed":
        return False, {"why": "the first browser run ended '%s', not 'failed', so a retry "
                              "cannot stand in for it" % first.get("status")}
    if not failed:
        return False, {"why": "the browser run failed with no failing test recorded "
                              "(a setup or server failure), so there is nothing to retry"}
    port = free_port()
    seed = os.path.join(tree, "test-results", "run-%d" % port, ".last-run.json")
    os.makedirs(os.path.dirname(seed), exist_ok=True)
    with open(seed, "w") as fh:
        json.dump({"status": "failed", "failedTests": failed}, fh)
    report = os.path.join(tree, "test-results", "merge-gate-retry.json")
    env = dict(os.environ, PLAYWRIGHT_PORT=str(port), PLAYWRIGHT_JSON_OUTPUT_FILE=report)
    code, out, err, timed_out = run_group(
        ["npx", "playwright", "test", "tests/sync-invariants/", "--last-failed",
         "--forbid-only", "--reporter=dot,json"], tree, RETRY_TIMEOUT, env=env,
        first=signal.SIGINT, grace=PLAYWRIGHT_GRACE, port=port)
    info = {"retried": len(failed), "exit": code, "tail": tail(out or err, 300)}
    if timed_out:
        info["why"] = "the retry ran past %d minutes" % (RETRY_TIMEOUT // 60)
        return False, info
    try:
        with open(report) as fh:
            ran = {}
            for s in json.load(fh).get("suites") or []:
                ran.update(spec_names(s))
    except (OSError, ValueError) as e:
        info["why"] = "the retry wrote no readable report: %s" % e
        return False, info
    info["ranTests"] = len(ran)
    missing = [i for i in failed if i not in ran]
    if missing:
        info["why"] = "%d of the failed tests were not re-run" % len(missing)
        return False, info
    skipped = [ran[i][1] for i in failed if ran[i][0] == "skipped"]
    if skipped:
        info["why"] = "retry skipped instead of passing"
        info["skipped"] = skipped[:20]
        return False, info
    still = [ran[i][1] for i in failed if ran[i][0] != "expected"]
    if still or code != 0:
        info["why"] = "red again on the retry"
        info["stillFailing"] = still[:20]
        return False, info
    info["flakyRetried"] = [ran[i][1] for i in failed]
    return True, info


def main_registry_ids(tree, base):
    """The PAGE_REGISTRY ids main had at the tested base, read with
    affected-pages.py's own parser from the merge tree. None when unreadable:
    then every FAIL or WARN page goes to the live re-walk, as before, and a page
    new in this PR reads there as "cannot judge", never as a pass."""
    r = run(["git", "show", "%s:js/config.js" % base], cwd=tree, timeout=30)
    if r.returncode != 0:
        progress("cannot read main's js/config.js at %s: %s" % (base[:8], tail(r.stderr, 120)))
        return None
    try:
        spec = importlib.util.spec_from_file_location(
            "affected_pages", os.path.join(tree, "scripts", "affected-pages.py"))
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        ids = {e["id"] for e in mod.parse_registry(r.stdout)}
    except Exception as e:           # reported, and the safe route is taken
        progress("cannot read main's page list (%s); every page goes to the live re-walk" % e)
        return None
    return ids or None


def affected_pages(tree, files):
    script = os.path.join(tree, "scripts", "affected-pages.py")
    if not os.path.isfile(script):
        return None, "scripts/affected-pages.py is missing from the merge result"
    r = run([sys.executable, script, "--stdin"], cwd=tree, timeout=AFFECTED_TIMEOUT,
            stdin="\n".join(files) + "\n")
    if r.returncode == 2:
        return None, "affected-pages.py could not read its page map (exit 2): %s" % tail(r.stderr, 200)
    if r.returncode != 0:
        return None, "affected-pages.py exited %d: %s" % (r.returncode, tail(r.stderr, 200))
    try:
        data = json.loads(r.stdout or "")
    except json.JSONDecodeError:
        return None, "affected-pages.py printed no JSON"
    if not isinstance(data, dict) or data.get("scope") not in ("none", "some", "all"):
        return None, "affected-pages.py gave no scope of none, some or all"
    pages = data.get("pages") or []
    if not isinstance(pages, list) or any(not isinstance(p, str) or not PAGE_ID.match(p) for p in pages):
        return None, "affected-pages.py gave page ids the walk cannot take: %r" % (pages,)
    if data["scope"] == "some" and not pages:
        return None, "affected-pages.py said some pages are touched but named none"
    data["pages"] = pages
    return data, None


def free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def launch_server(tree, port):
    """Only starts it. The caller holds the handle BEFORE the readiness poll, so
    an interrupt during the poll still stops the server."""
    return subprocess.Popen(
        [sys.executable, "-m", "http.server", str(port), "--bind", "127.0.0.1",
         "--directory", tree],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)


def wait_served(p, port, nonce):
    """None once the server on the port answers with THIS tree's nonce, else why.
    A server that answers with anything else is someone else's on a reused port."""
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    url = "http://127.0.0.1:%d/%s" % (port, NONCE_FILE)
    deadline = time.time() + SERVER_START_SECONDS
    while time.time() < deadline:
        if p.poll() is not None:
            return "the local server exited at once (code %s)" % p.returncode
        try:
            with opener.open(url, timeout=2) as resp:
                got = resp.read(200).decode("utf-8", "replace").strip()
            if got == nonce:
                return None
            return "port %d is not serving the merge result (nonce mismatch)" % port
        except OSError as e:
            if getattr(e, "code", None):                 # an HTTP error: something answered
                return "port %d is not serving the merge result (HTTP %s)" % (port, e.code)
            time.sleep(0.2)
    return "the local server did not answer within %ds" % SERVER_START_SECONDS


def run_walk(tree, base, only=None):
    """prod-walk.js in its own process group, so a timeout also stops the
    browser it started. Returns the run dict verdict() reads."""
    args = ["node", os.path.join(tree, "scripts", "prod-walk.js"), "--base", base]
    if only:
        args += ["--only", ",".join(only)]
    t = time.time()
    code, out, err, timed_out = run_group(args, cwd=tree, timeout=WALK_TIMEOUT,
                                          first=signal.SIGINT)
    result = None
    text = (out or "").strip()
    try:
        result = json.loads(text) if text else None
    except json.JSONDecodeError:
        a, b = text.find("{"), text.rfind("}")
        try:
            result = json.loads(text[a:b + 1]) if 0 <= a < b else None
        except json.JSONDecodeError:
            result = None
    return {"requested": list(only or []), "exit": code,
            "timedOut": timed_out, "result": result if isinstance(result, dict) else None,
            "stderrTail": tail(err, 300), "seconds": round(time.time() - t)}


def fixer_leftovers(pr):
    """Every fixer-merge-<pr>-* path: registered worktrees and bare temp dirs."""
    prefix = "fixer-merge-%d-" % pr
    found = set()
    r = run(["git", "worktree", "list", "--porcelain"], timeout=30)
    for line in (r.stdout or "").splitlines():
        if line.startswith("worktree ") and os.path.basename(line[9:]).startswith(prefix):
            found.add(os.path.realpath(line[9:]))
    for d in glob.glob(os.path.join(tempfile.gettempdir(), prefix + "*")):
        found.add(os.path.realpath(d))
    return found


def delete_remote_branch(facts):
    """(deleted?, why). Deletes the PR's head branch on GitHub only, never locally."""
    name = facts.get("headRefName") or ""
    repo = (facts.get("headRepository") or {}).get("nameWithOwner") or ""
    if facts.get("isCrossRepository"):
        return False, "the head branch is on a fork; left alone"
    if not name or not repo:
        return False, "gh gave no head branch or repository"
    if name in ("main", "master") or name == facts.get("baseRefName"):
        return False, "refusing to delete %s" % name
    try:
        r = run(["gh", "api", "-X", "DELETE", "repos/%s/git/refs/heads/%s"
                 % (repo, urllib.parse.quote(name, safe="/"))], timeout=60)
    except (OSError, subprocess.TimeoutExpired) as e:
        return False, "could not run gh: %s" % e
    if r.returncode == 0:
        return True, None
    said = tail((r.stdout or "") + (r.stderr or ""), 200)
    if "Reference does not exist" in said:
        return True, "already gone (GitHub may delete merged branches itself)"
    return False, said or "gh api exited %d" % r.returncode


def do_merge(pr, facts, head):
    args = ["gh", "pr", "merge", str(pr), "--squash"]
    if head:
        args += ["--match-head-commit", head]
    try:
        m = run(args, timeout=180)
        said = (m.stdout or "") + (m.stderr or "")
    except (OSError, subprocess.TimeoutExpired) as e:
        # A merge call that hung may still have merged: never stop here, ask.
        said = "gh pr merge did not finish: %s" % e
    # gh exits non-zero when it cannot check out main locally (a worktree holds
    # it), even though the merge worked. Ask the API, not the exit code.
    state = {}
    try:
        st = run(["gh", "pr", "view", str(pr), "--json", "state,mergedAt"], timeout=60)
        state = json.loads(st.stdout or "{}")
    except (OSError, subprocess.TimeoutExpired, json.JSONDecodeError) as e:
        said += " | could not confirm the PR state: %s" % e
    merged = isinstance(state, dict) and state.get("state") == "MERGED"
    out = {"merged": merged, "mergeOutput": tail(said, 300)}
    if merged:
        out["branchDeleted"], out["branchWhy"] = delete_remote_branch(facts)
    return out


def log_line(pr, head, status, why, flaky=None):
    try:
        path = os.path.join(os.path.expanduser("~"), "knowledge-os", "logs", "merge-gate.log")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        clean = re.sub(r"[\t\r\n]+", " ", str(why or ""))[:200]
        flaky_text = re.sub(r"[\t\r\n]+", " ", "; ".join(flaky))[:300] if flaky else "-"
        with open(path, "a") as fh:
            fh.write("%s\t%s\t%s\t%s\t%s\t%s\n" % (
                stamp, pr if pr else "-", (head or "-")[:8], status, clean, flaky_text))
    except Exception as exc:     # a log failure never changes the result
        print("merge-pr: could not write the log: %s" % exc, file=sys.stderr)


# ─── THE RUN ──────────────────────────────────────────────────────────

def gate(pr, dry_run):
    """Returns (result dict, exit code)."""
    res = {"pr": pr, "dryRun": dry_run, "testedTree": None, "base": None, "head": None,
           "vitest": None, "browser": None, "walk": None, "protectedPathsTouched": [],
           "merged": False, "why": "", "seconds": 0}

    def refuse(why):
        res["why"] = why
        return res, 1

    progress("reading PR #%d" % pr)
    facts, err = pr_facts(pr)
    if err:
        return refuse(err)
    res["title"] = facts.get("title")
    res["headAtView"] = facts.get("headRefOid")
    res["head"] = facts.get("headRefOid")
    if facts.get("state") != "OPEN":
        return refuse("PR #%d is %s, not OPEN; nothing to merge" % (pr, facts.get("state")))
    if facts.get("isDraft") and not dry_run:
        return refuse("PR #%d is a draft; mark it ready first (a draft may be --dry-run)" % pr)
    if facts.get("baseRefName") != "main":
        return refuse("PR #%d targets %s, not main; this gate tests main + the PR"
                      % (pr, facts.get("baseRefName")))

    fm = fixer()
    tree = server = None
    try:
        progress("building origin/main + PR #%d in a throwaway worktree" % pr)
        before = fixer_leftovers(pr)
        try:
            tree, err = fm.build_merge_result(pr)
        except BaseException:
            # Interrupted or crashed WHILE building: the build may have
            # registered a worktree it never returned. Remove what appeared
            # during this run, and only here: after an ordinary refusal, a
            # fixer-merge-<pr>-* worktree is the queue fixer building the same PR.
            for left in fixer_leftovers(pr) - before:
                progress("removing a worktree the interrupted build left: %s" % left)
                fm.destroy_merge_result(left)
            raise
        if err:
            return refuse("could not build the merge result: %s" % err)
        res["testedTree"] = tree
        base, head, err = tree_shas(tree)
        if err:
            return refuse("cannot judge: " + err)
        res["base"], res["head"] = base, head
        files, err = tree_files(tree, base, head)
        if err:
            return refuse("cannot judge: " + err)
        res["files"] = len(files)
        res["protectedPathsTouched"] = fm.protected_hits(files)

        progress("running vitest, then the browser suite, on the merge result")
        gate_ok, g, first_port = run_suites(tree)
        res["vitest"] = g.get("vitest")
        res["browser"] = g.get("browser") or {"ok": None, "tail": "not run: vitest was red"}
        if (not gate_ok and (res["vitest"] or {}).get("ok") and res["browser"].get("ok") is False
                and not res["browser"].get("timedOut")):
            progress("browser suite red; re-running only the tests that failed, once")
            green, info = retry_browser(tree, first_port)
            res["browser"]["retry"] = info
            res["browser"]["okAfterRetry"] = green
            if green:
                res["browser"]["flakyRetried"] = info["flakyRetried"]
                gate_ok = True
                progress("green on the retry: %d flaky test(s)" % len(info["flakyRetried"]))

        walk = live = regate = main_ids = None
        if gate_ok:
            progress("tests green; working out which pages the PR touches")
            aff, aerr = affected_pages(tree, files)
            if aerr:
                walk = {"scope": None, "error": "cannot tell which pages the PR touches: " + aerr}
            elif aff["scope"] == "none":
                walk = {"scope": "none", "affected": aff}
            else:
                only = aff["pages"] if aff["scope"] == "some" else None
                main_ids = main_registry_ids(tree, base)
                nonce = secrets.token_hex(16)
                with open(os.path.join(tree, NONCE_FILE), "w") as fh:
                    fh.write(nonce + "\n")
                port = free_port()
                server = launch_server(tree, port)
                serr = wait_served(server, port, nonce)
                if serr:
                    walk = {"scope": aff["scope"], "error": serr}
                else:
                    here = "http://127.0.0.1:%d/" % port
                    progress("walking %s on the merge result (127.0.0.1:%d)"
                             % (", ".join(only) if only else "every page", port))
                    walk = run_walk(tree, here, only)
                    walk["scope"] = aff["scope"]
                    walk["affected"] = aff
                    ids = recheck_ids(walk, main_ids)
                    if ids:
                        progress("walking %s again on the live site to compare" % ", ".join(ids))
                        live = run_walk(tree, LIVE, ids)
                    first = walk_findings(walk, live, None, main_ids)
                    if first["gateOnly"] and not first["cannot"]:
                        progress("only a gate is new on %s; walking it once more locally"
                                 % ", ".join(first["gateOnly"]))
                        regate = run_walk(tree, here, first["gateOnly"])
                stop_group(server)
                server = None
        merge, why = verdict(gate_ok, walk, live, regate, main_ids)
        res["walk"] = walk_summary(walk, live, regate, main_ids)
    finally:
        stop_group(server)
        if tree:
            progress("removing the merge worktree")
            fm.destroy_merge_result(tree)

    res["why"] = why
    if not merge:
        return res, 1
    progress("green; checking origin/main has not changed the same files")
    mc = main_check(base, files)
    res["mainNow"] = mc.get("mainNow")
    res["mainMovedBy"] = mc.get("mainMovedBy")
    if mc.get("refuse"):
        res["why"] = mc["refuse"]
        return res, 1
    if dry_run:
        res["why"] = "DRY RUN, nothing merged: " + why
        return res, 0
    progress("merging PR #%d" % pr)
    m = do_merge(pr, facts, head)
    res.update(m)
    if not m["merged"]:
        res["why"] = "the gate was green but GitHub did not merge: %s" % (m.get("mergeOutput") or "no output")
        return res, 1
    res["why"] = "merged: " + why
    return res, 0


class Args(argparse.ArgumentParser):
    def error(self, message):
        raise ValueError(message)


def positive(text):
    n = int(text)
    if n <= 0:
        raise ValueError
    return n


def _interrupt(signum, frame):
    raise KeyboardInterrupt("signal %d" % signum)


def main(argv=None):
    p = Args(prog="merge-pr.py", description="Gate, then merge, one PR.")
    p.add_argument("--pr", type=positive, required=True)
    p.add_argument("--dry-run", action="store_true")
    try:
        a = p.parse_args(argv)
    except (ValueError, TypeError) as e:
        why = "bad arguments: %s (usage: merge-pr.py --pr N [--dry-run])" % (e or "a positive PR number is needed")
        print(json.dumps({"pr": None, "merged": False, "why": why}, indent=2))
        log_line(None, None, "BROKE", why)
        return 2
    # A killed background task must still remove its worktree: turn TERM and
    # HUP into the same path as Ctrl-C, which runs every finally.
    signal.signal(signal.SIGTERM, _interrupt)
    signal.signal(signal.SIGHUP, _interrupt)
    try:
        res, code = gate(a.pr, a.dry_run)
    except BaseException as e:
        why = "the gate itself broke: %s: %s" % (type(e).__name__, str(e)[:300])
        res, code = {"pr": a.pr, "dryRun": a.dry_run, "merged": False, "why": why}, 2
    res["seconds"] = round(time.time() - T0)
    print(json.dumps(res, indent=2))
    if code == 2:
        status = "BROKE"
    elif a.dry_run:
        status = "DRYRUN-GREEN" if code == 0 else "DRYRUN-RED"
    else:
        status = "MERGED" if res.get("merged") else "REFUSED"
    log_line(a.pr, res.get("head"), status, res.get("why"),
             (res.get("browser") or {}).get("flakyRetried"))
    return code


if __name__ == "__main__":
    sys.exit(main())
