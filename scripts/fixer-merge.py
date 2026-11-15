#!/usr/bin/env python3
"""The gate the queue fixer must pass before its own work reaches main.

WHY THIS EXISTS (29 Aug 2026, Kevin's ruling: "the fixer needs to merge them
all so that there's nothing left hanging that's not finished").

The fixer wrote fixes and opened a PR it was forbidden to merge. That made
Kevin the drain on the whole queue, and he is not a code reviewer — on 29 Aug
there were 213 open findings (4 critical, 59 high), 8 more in overflow, and two
fixer PRs sitting unmerged. The routine's own skill already said the quiet part:
until he merges them "the fix queue has a drain rate of zero and everything you
write today is theatre."

So the fixer merges its own work now. What replaces Kevin's review is NOT
nothing — it is this script, and it is stricter than a glance:

  1. THE FULL GATE RUNS, not a subset. `npm test` is vitest only; the browser
     suite is where render, state and PATCH-payload bugs live, and both of this
     platform's worst incidents would have walked through a vitest-only check.
  2. PROTECTED PATHS ARE NEVER AUTO-MERGED. Money, auth, the approval loop
     itself, the outbound send path, the shared files every page loads, and
     (21 Sep 2026) the robots' permissions (deny list, tool list, runners). A
     wrong fix in any of those is not a bug, it is an incident, and those still
     stop at Kevin. Since 7 Oct 2026 they stop at him as ONE MERGE card in his
     approval queue (scripts/merge_card.py), raised only when the gate is green,
     and scripts/merge-approved.py merges it through merge-pr.py once he
     approves. Before that they stopped as an open PR that told nobody.
  3. A RED GATE LEAVES THE PR OPEN. It never merges "probably fine".
  4. IT TESTS THE MERGE RESULT, not the main checkout. Added 1 Sep 2026 after
     finding 414: the gate used to run wherever it happened to be standing, so
     it passed #196 on 1748 tests while the branch it merged runs 1777. It now
     builds origin/main + the PR in a throwaway worktree and tests that.
  5. A SECOND REVIEWER PASSES IT FIRST (Kevin, 22 Oct 2026). On a green gate,
     scripts/fixer-review.py back-tests the PR's changed tests and puts one
     read-only reviewer on the same tree, on the base pinned before it was
     built. Nothing merges and no MERGE card is raised unless it passed exactly
     the head the gate tested, and the merge names that head.

Usage:
    fixer-merge.py check --pr 123          # decide, run nothing
    fixer-merge.py merge --pr 123          # gate + merge, or refuse loudly
Exit: 0 merged or safely refused-and-reported, 1 the gate itself broke.
"""

import argparse
import datetime
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# ─── WHAT NEVER MERGES ITSELF ────────────────────────────────────────
#
# Chosen by what has actually caused incidents in this repo, not by feel:
#   * money — the Report Amount blanking (8,667 transactions) and the split
#     sign-flip both lived here, and both passed the fixture suite.
#   * the approval loop — a wrong fix here breaks the mechanism that stops
#     agents acting without Kevin. It must not be able to fix itself.
#   * the send path — an unrecallable email to a creditor or a prospect.
#   * shared files — config.js and shared.js load on every page, so a mistake
#     is not one broken page, it is all of them.
#   * workers — they need `wrangler deploy` anyway, so merging alone would
#     report a fix that never reached production.
PROTECTED = (
    "js/money.js", "js/reconciliation.js", "js/cashflow.js", "js/dashboard.js",
    "js/pnl.js", "js/wealth.js",
    "js/config.js", "js/shared.js",
    "js/agent-accuracy.js",
    "scripts/agent-dispatch.py", "scripts/send-email.py", "scripts/send-letter.py",
    "scripts/slack-automation/",
    "os/agents/index.html",
    # The gate itself. A wrong change here does not break one feature, it
    # removes the check that stands between every other change and main —
    # and it would be merged by the very code being changed. 1 Sep 2026.
    "scripts/fixer-merge.py",
    # The robots' permissions (21 Sep 2026, after PR #495). agent-settings.json
    # holds the deny list every headless run is started with, agent-tools.sh
    # the one definition of the tools it may use, and the five runners are what
    # pass both to claude. A fix that loosens any of them hands the robots the
    # power to edit code or push, so the fixer, itself a robot, must never be
    # able to merge one on its own.
    "scripts/agent-settings.json", "scripts/agent-tools.sh",
    "scripts/agent-slot-run.sh", "scripts/task-manager-run.sh",
    "scripts/inbound-triage-run.sh", "scripts/handback-poll-run.sh",
    "scripts/signin-pickup-run.sh", "scripts/roy-assistant-run.sh",
    # The MERGE card and the merger (7 Oct 2026). A fix that weakened either would let a
    # protected PR merge without Kevin, and it would merge itself through this very gate.
    "scripts/merge_card.py", "scripts/merge-approved.py", "scripts/merge-pr.py",
    "scripts/approval_evidence.py",
    # The second reviewer (Kevin, 22 Oct 2026). A fix that weakened it would pass itself.
    "scripts/fixer-review.py",
)


def sh(args, cwd=None, timeout=1800, env=None):
    # REPO is read at CALL time, not bound as a default at import time, so a
    # test can point the module at a scratch repo and actually exercise this.
    # env is MERGED over the inherited environment, never a replacement: a bare
    # dict would strip PATH and npx would not resolve.
    full = None
    if env:
        full = dict(os.environ)
        full.update(env)
    return subprocess.run(args, cwd=cwd or REPO, capture_output=True, text=True,
                          timeout=timeout, env=full)


def changed_files(pr):
    r = sh(["gh", "pr", "diff", str(pr), "--name-only"])
    if r.returncode != 0:
        sys.exit(f"ERROR: cannot read PR #{pr}: {(r.stderr or '').strip()[:200]}")
    return [f.strip() for f in (r.stdout or "").splitlines() if f.strip()]


def protected_hits(files):
    hits = []
    for f in files:
        for p in PROTECTED:
            if f == p or (p.endswith("/") and f.startswith(p)):
                hits.append({"file": f, "rule": p})
                break
    return hits


# ─── WHAT THE GATE MUST ACTUALLY TEST ────────────────────────────────
#
# Regression origin: 30 Aug 2026 (finding 20260830-queue-fixer-414), proven
# again on 1 Sep 2026. run_gate() used to run with cwd defaulting to REPO, so
# it tested WHATEVER THE MAIN CHECKOUT HAPPENED TO BE — never the PR. Two ways
# that lies, and both have happened:
#
#   * GREEN ON NOTHING. On 1 Sep the gate passed PR #196 reporting "1748 tests
#     passed". The PR added three test files. The real merge result runs 1777.
#     The 29 tests written to prove those fixes were never executed by the gate
#     that merged them.
#   * RED ON NOTHING. On 31 Aug the same gate failed #196 twice — once because
#     main was a commit behind origin, once because a tracked-mirror test only
#     goes green AFTER the PR lands. Neither red was the branch. A gate that
#     cries wolf is the shortest path to someone bypassing it.
#
# So the gate now materialises the tree that merging WOULD produce — origin/main
# with the PR merged into it — in a throwaway worktree, and runs both suites
# there. If the PR does not merge cleanly, that is a red gate, not a crash.


def _git(args, cwd=None):
    return sh(["git"] + args, cwd=cwd)


# ─── WHERE THE MERGE TREE'S node_modules COMES FROM ──────────────────
#
# Regression origin: 5 Oct 2026, PR #709. merge-pr.py was started from a
# session worktree (.claude/worktrees/texts-clicksend) that the desktop app
# made, not worktree.sh, so it had no node_modules. The merge tree's link
# pointed at REPO/node_modules, REPO being whichever checkout the script was
# started from, and nothing checked the target existed. The link dangled, npx
# fetched a throwaway vitest, vitest.config.js could not resolve
# 'vitest/config', and vitest died in 11 seconds before one test ran. The gate
# then said "RED". The same PR merged green from the main checkout minutes
# later.
#
# So the link now goes to the MAIN checkout's node_modules first (the parent
# of git's common dir, which every worktree shares), the invoking checkout's
# only as a fallback, and only to one that really holds both runners. When
# none does, the tree gets no link and tests_cannot_run() says why: a gate
# that never ran its tests must not read like a failed test.

RUNNERS = ("vitest", "@playwright/test")  # what the two suites start


def node_modules_problem(checkout):
    """None when <checkout>/node_modules holds both runners, else why not."""
    nm = os.path.join(checkout, "node_modules")
    if os.path.islink(nm) and not os.path.exists(nm):
        return "%s links to %s, which does not exist" % (nm, os.readlink(nm))
    if not os.path.isdir(nm):
        return "%s does not exist" % nm
    missing = [p for p in RUNNERS
               if not os.path.isfile(os.path.join(nm, p, "package.json"))]
    if missing:
        return "%s has no %s" % (nm, " and no ".join(missing))
    return None


def primary_checkout():
    """The repo's main working tree: the parent of git's common dir, which
    every worktree shares. None when git cannot say."""
    r = _git(["rev-parse", "--path-format=absolute", "--git-common-dir"])
    common = (r.stdout or "").strip()
    if r.returncode != 0 or not common:
        return None
    return os.path.dirname(os.path.normpath(common))


def node_modules_source():
    """(node_modules dir, None) from the first checkout that can run both
    suites, the main checkout first, then the invoking one. (None, why) when
    neither can."""
    seen, why = set(), []
    for checkout in (primary_checkout(), REPO):
        if not checkout or os.path.realpath(checkout) in seen:
            continue
        seen.add(os.path.realpath(checkout))
        problem = node_modules_problem(checkout)
        if problem is None:
            return os.path.realpath(os.path.join(checkout, "node_modules")), None
        why.append(problem)
    return None, "no usable node_modules: " + "; ".join(why)


def tests_cannot_run(tree):
    """None when both suites can start in this merge tree, else the plain
    reason they cannot. Asked before any suite runs."""
    problem = node_modules_problem(tree)
    if problem is None:
        return None
    _, why = node_modules_source()
    return "%s (%s)" % (problem, why) if why else problem


def build_merge_result(pr, base="origin/main"):
    """The tree that would be on main if this PR merged. (path, error)."""
    _git(["fetch", "origin", "main", "--quiet"])
    ref = "refs/fixer/pr-%d" % pr
    f = _git(["fetch", "--force", "origin", "pull/%d/head:%s" % (pr, ref)])
    if f.returncode != 0:
        return None, "cannot fetch PR #%d head: %s" % (
            pr, (f.stderr or "").strip()[-200:])

    path = tempfile.mkdtemp(prefix="fixer-merge-%d-" % pr)
    os.rmdir(path)  # git worktree add refuses a directory that exists
    w = _git(["worktree", "add", "--detach", path, base])
    if w.returncode != 0:
        return None, "cannot create worktree: %s" % (w.stderr or "").strip()[-200:]

    m = _git(["merge", "--no-edit", ref], cwd=path)
    if m.returncode != 0:
        destroy_merge_result(path)
        return None, "PR #%d does not merge cleanly onto %s: %s" % (
            pr, base, ((m.stdout or "") + (m.stderr or "")).strip()[-200:])

    # A fresh worktree has no node_modules and both suites need them. Link
    # rather than install: 90 seconds of npm ci per gate run is how a gate
    # becomes something people skip. Link only one that can run them (see
    # node_modules_source); with none, link nothing and let the gate's
    # tests_cannot_run() report why.
    link = os.path.join(path, "node_modules")
    if not os.path.lexists(link):
        src, _ = node_modules_source()
        if src:
            try:
                os.symlink(src, link)
            except OSError as e:
                destroy_merge_result(path)
                return None, "cannot link node_modules: %s" % e
    return path, None


def destroy_merge_result(path):
    if not path:
        return
    link = os.path.join(path, "node_modules")
    if os.path.islink(link):
        os.unlink(link)  # never let a recursive delete walk into the real one
    _git(["worktree", "remove", "--force", path])
    shutil.rmtree(path, ignore_errors=True)
    _git(["worktree", "prune"])


def _read_json(path):
    """A reporter's JSON file, or None. A gate must never die because a reporter
    wrote nothing: the tail is still there and the run still has a verdict."""
    try:
        with open(path) as fh:
            return json.load(fh)
    except Exception:
        return None


def failed_vitest(path):
    """[{file, test}] out of vitest's JSON report; [] when it cannot be read.

    WHY (finding 20261014-queue-fixer-867, seen 3 times): run_gate kept only a
    400-character tail per half, and vitest's tail is the summary counts, not
    the failing file. On 13 Oct 2026 the gate went RED twice on PR #762 and the
    only way to learn WHICH test failed was to rebuild the merge result by hand
    and run both suites again (12 minutes). A refusal nobody can diagnose is
    what teaches people to reach for SKIP_SYNC_TESTS=1."""
    d = _read_json(path)
    if not isinstance(d, dict):
        return []
    out = []
    for res in d.get("testResults") or []:
        if not isinstance(res, dict):
            continue
        name = res.get("name") or ""
        for a in res.get("assertionResults") or []:
            if isinstance(a, dict) and a.get("status") == "failed":
                out.append({"file": name, "test": a.get("fullName") or a.get("title") or ""})
        if not out and res.get("status") == "failed" and res.get("message"):
            # A file that fails to COLLECT has no assertions at all, and that is
            # the failure mode the tail hid worst: an import error reads as a
            # bare non-zero exit.
            out.append({"file": name, "test": "(file failed to run)"})
    return out


def failed_playwright(path):
    """[{file, test}] out of playwright's JSON report; [] when it cannot be read."""
    d = _read_json(path)
    if not isinstance(d, dict):
        return []
    out = []

    def walk(suite, path_parts):
        f = suite.get("file") or (path_parts[0] if path_parts else "")
        for spec in suite.get("specs") or []:
            if isinstance(spec, dict) and spec.get("ok") is False:
                out.append({"file": spec.get("file") or f, "test": spec.get("title") or ""})
        for inner in suite.get("suites") or []:
            if isinstance(inner, dict):
                walk(inner, [f])

    for suite in d.get("suites") or []:
        if isinstance(suite, dict):
            walk(suite, [])
    return out


def run_gate(cwd):
    """Both halves, against the MERGE RESULT. A green vitest with a red browser
    suite is not green, and neither is a green run of the wrong tree.

    Each half records the failing FILES and TEST NAMES as well as the tail, so a
    red gate names what broke instead of only that something did."""
    out = {"testedTree": cwd}
    reports = tempfile.mkdtemp(prefix="fixer-gate-reports-")
    try:
        vjson = os.path.join(reports, "vitest.json")
        v = sh(["npx", "vitest", "run", "--reporter=dot",
                "--reporter=json", "--outputFile.json=" + vjson], cwd=cwd)
        out["vitest"] = {"ok": v.returncode == 0,
                         "tail": (v.stdout or v.stderr or "").strip()[-400:],
                         "failed": failed_vitest(vjson)}
        if not out["vitest"]["ok"]:
            return False, out
        bjson = os.path.join(reports, "playwright.json")
        b = sh(["npx", "playwright", "test", "tests/sync-invariants/",
                "--reporter=dot,json"], cwd=cwd,
               env={"PLAYWRIGHT_JSON_OUTPUT_NAME": bjson})
        out["browser"] = {"ok": b.returncode == 0,
                          "tail": (b.stdout or b.stderr or "").strip()[-400:],
                          "failed": failed_playwright(bjson)}
        return out["vitest"]["ok"] and out["browser"]["ok"], out
    finally:
        shutil.rmtree(reports, ignore_errors=True)


def decide(pr):
    files = changed_files(pr)
    hits = protected_hits(files)
    return {"pr": pr, "files": len(files), "protected": hits,
            "mayAutoMerge": not hits}


def cmd_check(args):
    print(json.dumps(decide(args.pr), indent=2))
    return 0


def pr_facts(pr):
    """(title, url, every file the PR touches, head sha). gh is asked once; a failure raises."""
    r = sh(["gh", "pr", "view", str(pr), "--json", "title,url,files,headRefOid"])
    if r.returncode != 0:
        raise RuntimeError("cannot read PR #%d: %s" % (pr, (r.stderr or "").strip()[:200]))
    v = json.loads(r.stdout or "{}")
    return (v.get("title") or "", v.get("url") or "",
            [f.get("path") for f in v.get("files") or [] if isinstance(f, dict) and f.get("path")],
            v.get("headRefOid") or "")


def tested_head(pr):
    """The PR head build_merge_result fetched and the gate tested (refs/fixer/pr-N), or ''."""
    r = _git(["rev-parse", "--verify", "--quiet", "refs/fixer/pr-%d" % pr])
    sha = (r.stdout or "").strip()
    return sha if r.returncode == 0 and len(sha) == 40 else ""


def merge_cards():
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import merge_card
    return merge_card


# ─── THE SECOND REVIEWER (Kevin, 22 Oct 2026; card recWxof2DATkOQfcb) ──
#
# Green is not enough: before anything of the fixer's merges or reaches Kevin as a MERGE card,
# scripts/fixer-review.py runs the PR's changed tests on the code from before it and puts one
# read-only reviewer on THIS merge tree. Three rules from its independent review (15 Nov 2026):
# the base is pinned to one commit before the tree is built, so the gate, the back-test and the
# reviewer all judge the same change (A4); nothing merges or is carded unless the reviewer passed
# exactly the head the gate tested; and the merge names that head (B2).


def pinned_base():
    """origin/main fetched and resolved to ONE commit before the merge tree is built, or ''."""
    _git(["fetch", "origin", "main", "--quiet"])
    r = _git(["rev-parse", "--verify", "--quiet", "origin/main^{commit}"])
    sha = (r.stdout or "").strip()
    return sha if r.returncode == 0 and len(sha) == 40 else ""


def second_reviewer():
    """scripts/fixer-review.py beside this file, pointed at the same repository as the gate."""
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "fixer_review", os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixer-review.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    mod.REPO = mod.fm.REPO = REPO
    return mod


def run_second_review(pr, base, tree):
    """The reviewer's verdict on this tree, never an exception: anything that goes wrong, loading it
    included, is a could-not-run, so nothing merges and the JSON still says why (review C5)."""
    try:
        return second_reviewer().review(pr, base, tree=tree)
    except Exception as e:  # noqa: BLE001 — reported in the JSON as could-not-run, never swallowed
        print("SECOND REVIEW BROKE for PR #%d: %s" % (pr, e), file=sys.stderr)
        return {"pr": pr, "pass": False, "refusedBy": "cannot-run", "sendBack": [], "base": base,
                "why": "the second reviewer could not run: %s: %s" % (type(e).__name__, str(e)[:300])}


def second_review_passed(pr, head, review):
    """True only when this run's review passed AND the reviewer's own record says this exact head
    passed. A record that cannot be read is not a pass."""
    if not (head and isinstance(review, dict) and review.get("pass") is True and review.get("head") == head):
        return False
    try:
        return bool(second_reviewer().passed(pr, head))
    except Exception as e:  # noqa: BLE001 — cannot tell is not a pass, and it is said
        print("SECOND REVIEW RECORD UNREADABLE for PR #%d: %s" % (pr, e), file=sys.stderr)
        return False


def gh_pr_state(pr):
    """GitHub's state for PR (OPEN, CLOSED, MERGED), or raises with gh's words."""
    r = sh(["gh", "pr", "view", str(pr), "--json", "state"])
    if r.returncode != 0:
        raise RuntimeError("cannot read PR #%d's state: %s" % (pr, (r.stderr or "").strip()[:200]))
    return (json.loads(r.stdout or "{}") or {}).get("state") or ""


def standing_card(merge_card, pr):
    """(the card that answers for PR, or None; words saying why a closed card was kept, or "").
    A card the ROBOT closed because the PR was closed unmerged is no decision, but only while GitHub
    says the PR is OPEN now (15 Nov 2026 review N1): a PR still closed keeps it, or every fixer run
    would raise a card the robot closes again. Which cards the robot closed comes from its own record
    (merge_card.robot_closed_cards, review N5); a record or a state that cannot be read keeps the card
    (the safe side) and says so. A card Kevin rejected always answers."""
    closed, problem = merge_card.robot_closed_cards(pr)
    old = merge_card.existing_card(pr, robot_closed=closed) if closed else merge_card.existing_card(pr)
    if not old or old.get("status") != "Completed" or old.get("outcome") == "Rejected" or old.get("id") not in closed:
        return old, problem
    try:
        state = gh_pr_state(pr)
    except Exception as e:  # noqa: BLE001 — not read is not "open": the old card keeps blocking
        return old, "the robot closed card %s, and PR #%d's state could not be read: %s" % (old["id"], pr, e)
    if state != "OPEN":
        return old, ""
    return None, ""


def raise_merge_card(pr, d, gate):
    """ONE card in Kevin's queue for a green protected PR (Kevin, 7 Oct 2026), never two:
    a card already raised for this PR, at any status, is returned instead. Returns a dict
    saying which, or {"error": ...}; it never raises, because the PR is still open and safe
    whether or not the card was written, and the result must say so either way."""
    try:
        merge_card = merge_cards()
        import findings
        old, kept = standing_card(merge_card, pr)
        title, url, files, gh_head = pr_facts(pr)
        # The head the gate tested. gh's head is only a fallback, and merge-pr.py --expect-head
        # re-gates whatever is approved, so a stale fallback can never merge untested code.
        head = gate.get("head") or gh_head
        if not head:
            # His approval must name the code it approves: no tested head, no card (review).
            raise RuntimeError("no tested head for PR #%d (refs/fixer and gh both failed)" % pr)
        if old and (old["status"] == "Completed" or old.get("head") == head):
            # A rejected or merged card is never raised again, and an open one for this very
            # head is already the card: approved twice, refused twice, still ONE card.
            return {"task": old.get("id"), "already": True, **({"note": kept} if kept else {})}
        pending = [(r["id"], r.get("title", "")) for r in findings.current_state().values()
                   if r.get("status") == "pending" and str(r.get("pr", "")) == str(pr)]
        fields = merge_card.card_fields(pr, title, url, sorted(pending), files,
                                        [h["file"] for h in d["protected"]], gate,
                                        datetime.date.today().isoformat(), head)
        if old:
            # The PR changed after its card was raised. His approval was of the old head, so the
            # same card is refreshed in place with the new result and asked again (review, 7 Oct).
            stamp = datetime.datetime.now().strftime("%d %b %Y %H:%M")
            note = ("[%s — fixer-merge] MERGE CARD REFRESHED: PR #%d changed (tested head %s, was %s). "
                    "Any earlier approval was of the old code, so it is asked again." % (
                        stamp, pr, head[:12] or "?", (old.get("head") or "?")[:12]))
            merge_card.patch_card(old["id"], {
                merge_card.F["agentOutput"]: fields[merge_card.F["agentOutput"]],
                merge_card.PLAIN_SUMMARY: fields[merge_card.PLAIN_SUMMARY],
                merge_card.F["approvalOutcome"]: None, merge_card.F["status"]: "Approval",
                merge_card.F["notes"]: (str(old.get("notes") or "").rstrip() + "\n\n" + note).strip()[-90000:]})
            return {"task": old["id"], "already": False, "refreshed": True, "findings": [p[0] for p in pending]}
        return {"task": merge_card.create_card(fields), "already": False, "findings": [p[0] for p in pending]}
    except Exception as e:  # noqa: BLE001 — reported in the JSON, never swallowed
        print("MERGE CARD NOT RAISED for PR #%d: %s" % (pr, e), file=sys.stderr)
        return {"error": str(e)[:300]}


def teardown_workspace(branch, merge_output=""):
    """Tear the merged branch's workspace down, here, in the same breath as the merge
    (finding 20261102-queue-fixer-1170).

    STEP 5b of the queue-fixer skill said to run `worktree.sh done` after a successful
    merge and nothing enforced it, so on 2 Nov 2026 five merged fixer workspaces were
    still on disk, two of them three and four weeks old. Each is a checkout something
    can be run from by mistake, which is finding 20260909-queue-fixer-504, where
    content-engine ran from a worktree five commits behind main. A run that hits its
    time ceiling never reaches its own step 5b; this one cannot be skipped.

    worktree.sh done already REFUSES while anything would be lost - uncommitted files,
    commits that exist nowhere else, a branch not merged into origin/main - so a refusal
    is information and is reported, never forced past.
    """
    topic = branch.split("/", 1)[1] if "/" in branch else branch
    out = {"branch": branch, "topic": topic}
    # NEVER these two. content-engine-runtime is checked out on main on purpose for the
    # nightly and daytime content-engine jobs, and removing it breaks both with no error.
    if not topic or topic in ("main", "content-engine-runtime"):
        out["skipped"] = "never torn down: %s" % (topic or "no branch name")
        return out
    path = os.path.join(REPO, ".claude", "worktrees", topic)
    if not os.path.isdir(path):
        out["skipped"] = "no workspace on disk"
    else:
        r = sh(["bash", os.path.join(REPO, "scripts", "worktree.sh"), "done", topic], timeout=300)
        out["removed"] = r.returncode == 0
        out["say"] = (r.stdout or r.stderr or "").strip()[-400:]
    # The other side of the same shape, PR #871 on 2 Nov: gh could not delete the merged
    # branch BECAUSE a worktree still held it, and said so only in git's own words.
    if re.search(r"worktree|already checked out|cannot force update|cannot lock ref",
                 merge_output or "", re.I):
        out["note"] = ("the merge could not delete the branch because a worktree still held "
                       "it; that workspace is the one torn down here")
    return out


def _local_checkout_verdict(said, merged):
    """merge-pr.py's own verdict on a git error that sits beside a confirmed merge.

    Loaded from the merger rather than reimplemented, so the gate and the merger cannot
    drift on what counts as benign. If it cannot be loaded, nothing is called benign.
    """
    import importlib.util
    path = os.path.join(REPO, "scripts", "merge-pr.py")
    try:
        spec = importlib.util.spec_from_file_location("merge_pr", path)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod.local_checkout_verdict(said, merged)
    except Exception as exc:                        # noqa: BLE001 - any failure reads as "not benign"
        return {"benign": False,
                "unchecked": "could not read merge-pr.py's verdict (%s)" % str(exc)[:120]}


def cmd_merge(args):
    d = decide(args.pr)
    # A protected PR is never merged here (the refusal below comes before the merge call). Its
    # gate still runs, because Kevin's MERGE card carries the test result, and a red protected
    # PR must not reach his queue at all (7 Oct 2026; until then it went nowhere either way).
    # A card that already stands for this PR's current head needs no second gate (review).
    if not d["mayAutoMerge"]:
        try:
            old, why = standing_card(merge_cards(), args.pr)
            if why:
                print("MERGE CARD CHECK for PR #%d: %s" % (args.pr, why), file=sys.stderr)
            now_head = pr_facts(args.pr)[3] if old else ""
        except Exception as e:  # noqa: BLE001 — cannot tell: run the gate, which says so too
            print("MERGE CARD CHECK FAILED for PR #%d: %s" % (args.pr, e), file=sys.stderr)
            old, now_head = None, ""
        if old and (old["status"] == "Completed" or (now_head and old.get("head") == now_head)):
            print(json.dumps({**d, "merged": False, "mergeCard": {"task": old["id"], "already": True},
                              "secondReview": None,
                              "why": "touches a protected path; its MERGE card already stands (%s)"
                                     % (old["status"] or "open"),
                              "tell Kevin": [h["file"] for h in d["protected"]]}, indent=2))
            return 0
    # secondReview is in the JSON on EVERY path (null when the run never got that far), so the
    # fixer's report line always has a source (review C6).
    review = None
    base = pinned_base()
    if not base:
        print(json.dumps({**d, "merged": False, "gate": {"error": "could not pin origin/main to a commit"},
                          "secondReview": None,
                          "why": "could not pin the base commit — left open, nothing merged"}, indent=2))
        return 0
    tree, err = build_merge_result(args.pr, base)
    if err:
        # Cannot build the merge result = cannot judge it. That is a red gate,
        # never a pass. A conflicting PR lands here and stays open.
        print(json.dumps({**d, "merged": False, "gate": {"error": err}, "secondReview": None,
                          "why": "could not build the merge result — "
                                 "left open, nothing merged"}, indent=2))
        return 0
    head = tested_head(args.pr)
    try:
        cannot = tests_cannot_run(tree)
        if cannot:
            ok, gate = False, {"testedTree": tree, "testsRan": False}
        else:
            ok, gate = run_gate(tree)
        if ok:
            # Only on a green gate, in this same tree, on the base it was built on.
            review = run_second_review(args.pr, base, tree)
    finally:
        destroy_merge_result(tree)
    gate["head"] = head
    gate["base"] = base
    if cannot:
        # Not a red gate: no test ran. Saying RED here is how a broken
        # workspace gets mistaken for a broken PR (5 Oct 2026, PR #709).
        print(json.dumps({**d, "merged": False, "gate": gate, "secondReview": None,
                          "why": "tests could not run: %s. Left open, nothing merged"
                                 % cannot}, indent=2))
        return 0
    if not ok:
        print(json.dumps({**d, "merged": False, "gate": gate, "secondReview": None,
                          "why": "the gate is RED — left open, nothing merged"},
                         indent=2))
        return 0
    if not second_review_passed(args.pr, head, review):
        # Sent back, rounds used, or the reviewer could not run: no merge and no MERGE card, raised
        # or refreshed. The queue-fixer skill (STEP 5a) says what the fixer does next.
        print(json.dumps({**d, "merged": False, "gate": gate, "secondReview": review,
                          "why": "the second reviewer did not pass head %s: %s. Nothing merged and no MERGE card"
                                 % (head[:12] or "?", (review or {}).get("why") or "no review recorded")},
                         indent=2))
        return 0
    if not d["mayAutoMerge"]:
        # Not a failure. The PR is green and fine; it touches a protected path, so the
        # merge is Kevin's: ONE MERGE card goes to his queue, and scripts/merge-approved.py
        # runs merge-pr.py once he approves (7 Oct 2026). Before this the PR sat open and
        # "left open for Kevin" reached nobody.
        card = raise_merge_card(args.pr, d, gate)
        print(json.dumps({**d, "merged": False, "gate": gate, "mergeCard": card, "secondReview": review,
                          "why": ("touches a protected path; the gate is green, so a MERGE card "
                                  "is in Kevin's queue" if not card.get("error") else
                                  "touches a protected path; the gate is green but the MERGE card "
                                  "could not be raised: " + card["error"]),
                          "tell Kevin": [h["file"] for h in d["protected"]]},
                         indent=2))
        return 0 if not card.get("error") else 1
    # The merge names the head the gate tested and the reviewer passed: a push in between makes
    # GitHub refuse it rather than merge code nobody reviewed (review B2).
    m = sh(["gh", "pr", "merge", str(args.pr), "--squash", "--delete-branch", "--match-head-commit", head])
    # gh exits non-zero when it cannot check out main locally (a worktree holds
    # it), even though the merge itself succeeded. Confirm against the API
    # rather than trusting the exit code.
    st = sh(["gh", "pr", "view", str(args.pr), "--json", "state,mergedAt"])
    state = {}
    try:
        state = json.loads(st.stdout or "{}")
    except json.JSONDecodeError:
        pass
    merged = state.get("state") == "MERGED"
    said = (m.stdout or m.stderr or "").strip()
    out = {**d, "merged": merged, "gate": gate, "secondReview": review, "mergeOutput": said[-200:]}
    # The same reading merge-pr.py makes, and from the same place, so the two can never
    # disagree about whether a git error beside merged:true is the local checkout this Mac
    # cannot do or a real half-merge (findings 20261025-queue-fixer-1081 and
    # 20261005-daily-ops-749). Imported rather than re-matched: a second copy of the regex is
    # a second thing to drift.
    out["localCheckout"] = _local_checkout_verdict(said, merged) or {"benign": False}
    if out["localCheckout"].get("benign"):
        out["mergeOutputBenign"] = True
    if merged:
        # Only now are the findings genuinely fixed. Closing them before the
        # merge is what put forty findings on record as done against four PRs
        # that never landed (26 Aug 2026).
        land = sh([sys.executable, os.path.join(REPO, "scripts", "findings.py"),
                   "land", "--pr", str(args.pr)])
        out["landed"] = (land.stdout or "").strip()[-200:]
        br = sh(["gh", "pr", "view", str(args.pr), "--json", "headRefName"])
        branch = ""
        try:
            branch = (json.loads(br.stdout or "{}").get("headRefName") or "")
        except json.JSONDecodeError:
            pass
        out["workspace"] = (teardown_workspace(branch, out["mergeOutput"]) if branch
                            else {"skipped": "could not read the PR's branch name"})
    print(json.dumps(out, indent=2))
    return 0


def exit_on_signals():
    """A TERM, HUP or INT becomes SystemExit, so every `finally` runs: the merge tree and the review's
    trees are removed and fixer-review.py's run_group stops its child's group (second review M5).
    Python's default for TERM skips every finally and leaves them behind. A SIGKILL cannot be caught:
    run_group's watchdog covers the reviewer and vitest children then."""
    import signal

    def stop(signum, frame):
        raise SystemExit(128 + signum)
    for sig in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
        signal.signal(sig, stop)


def main():
    exit_on_signals()
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    for name, fn in (("check", cmd_check), ("merge", cmd_merge)):
        s = sub.add_parser(name)
        s.add_argument("--pr", type=int, required=True)
        s.set_defaults(func=fn)
    a = p.parse_args()
    sys.exit(a.func(a))


if __name__ == "__main__":
    main()
