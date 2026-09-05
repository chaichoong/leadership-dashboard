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
     itself, the outbound send path, and the shared files every page loads. A
     wrong fix in any of those is not a bug, it is an incident, and those still
     stop at Kevin as a PR.
  3. A RED GATE LEAVES THE PR OPEN. It never merges "probably fine".
  4. IT TESTS THE MERGE RESULT, not the main checkout. Added 1 Sep 2026 after
     finding 414: the gate used to run wherever it happened to be standing, so
     it passed #196 on 1748 tests while the branch it merged runs 1777. It now
     builds origin/main + the PR in a throwaway worktree and tests that.

Usage:
    fixer-merge.py check --pr 123          # decide, run nothing
    fixer-merge.py merge --pr 123          # gate + merge, or refuse loudly
Exit: 0 merged or safely refused-and-reported, 1 the gate itself broke.
"""

import argparse
import json
import os
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
)


def sh(args, cwd=None, timeout=1800):
    # REPO is read at CALL time, not bound as a default at import time, so a
    # test can point the module at a scratch repo and actually exercise this.
    return subprocess.run(args, cwd=cwd or REPO, capture_output=True, text=True,
                          timeout=timeout)


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
    # becomes something people skip.
    link = os.path.join(path, "node_modules")
    if not deps_resolve(path) and not os.path.exists(link):
        try:
            os.symlink(os.path.join(REPO, "node_modules"), link)
        except OSError as e:
            destroy_merge_result(path)
            return None, "cannot link node_modules: %s" % e
    return path, None


def deps_resolve(cwd):
    """Do the two suites actually resolve from here? node walks UP from cwd, so a
    worktree inside the repo can borrow the main checkout's node_modules — and a
    node_modules directory holding only a .vite cache passes os.path.exists while
    resolving nothing (finding 20260904-queue-fixer-452)."""
    d = os.path.abspath(cwd)
    while True:
        b = os.path.join(d, "node_modules", ".bin")
        if os.path.exists(os.path.join(b, "vitest")) and os.path.exists(os.path.join(b, "playwright")):
            return True
        parent = os.path.dirname(d)
        if parent == d:
            return False
        d = parent


def destroy_merge_result(path):
    if not path:
        return
    link = os.path.join(path, "node_modules")
    if os.path.islink(link):
        os.unlink(link)  # never let a recursive delete walk into the real one
    _git(["worktree", "remove", "--force", path])
    shutil.rmtree(path, ignore_errors=True)
    _git(["worktree", "prune"])


def run_gate(cwd):
    """Both halves, against the MERGE RESULT. A green vitest with a red browser
    suite is not green, and neither is a green run of the wrong tree.

    Returns (ok, out). `ok` is None for CANNOT RUN, which is not the same verdict
    as False: a missing dependency says nothing about the change, and a false red
    on the gate is what teaches people to bypass it (5 Sep 2026)."""
    out = {"testedTree": cwd}
    if not deps_resolve(cwd):
        out["cannotRun"] = ("gate could not run: node_modules resolves neither "
                            "vitest nor playwright from %s. This is NOT a red on "
                            "the change. Install or link dependencies and re-run." % cwd)
        return None, out
    v = sh(["npx", "vitest", "run"], cwd=cwd)
    out["vitest"] = {"ok": v.returncode == 0,
                     "tail": (v.stdout or v.stderr or "").strip()[-400:]}
    if not out["vitest"]["ok"]:
        return False, out
    b = sh(["npx", "playwright", "test", "tests/sync-invariants/",
            "--reporter=dot"], cwd=cwd)
    out["browser"] = {"ok": b.returncode == 0,
                      "tail": (b.stdout or b.stderr or "").strip()[-400:]}
    return out["vitest"]["ok"] and out["browser"]["ok"], out


def decide(pr):
    files = changed_files(pr)
    hits = protected_hits(files)
    return {"pr": pr, "files": len(files), "protected": hits,
            "mayAutoMerge": not hits}


def cmd_check(args):
    print(json.dumps(decide(args.pr), indent=2))
    return 0


def cmd_merge(args):
    d = decide(args.pr)
    if not d["mayAutoMerge"]:
        # Not a failure. The PR is fine; it just needs eyes, and saying so is
        # the whole point of having a protected list.
        print(json.dumps({**d, "merged": False,
                          "why": "touches a protected path — left open for Kevin",
                          "tell Kevin": [h["file"] for h in d["protected"]]},
                         indent=2))
        return 0
    tree, err = build_merge_result(args.pr)
    if err:
        # Cannot build the merge result = cannot judge it. That is a red gate,
        # never a pass. A conflicting PR lands here and stays open.
        print(json.dumps({**d, "merged": False, "gate": {"error": err},
                          "why": "could not build the merge result — "
                                 "left open, nothing merged"}, indent=2))
        return 0
    try:
        ok, gate = run_gate(tree)
    finally:
        destroy_merge_result(tree)
    if ok is None:
        print(json.dumps({**d, "merged": False, "gate": gate,
                          "why": "the gate COULD NOT RUN — left open, nothing "
                                 "merged, and this is not a verdict on the change"},
                         indent=2))
        return 0
    if not ok:
        print(json.dumps({**d, "merged": False, "gate": gate,
                          "why": "the gate is RED — left open, nothing merged"},
                         indent=2))
        return 0
    m = sh(["gh", "pr", "merge", str(args.pr), "--squash", "--delete-branch"])
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
    out = {**d, "merged": merged, "gate": gate,
           "mergeOutput": (m.stdout or m.stderr or "").strip()[-200:]}
    if merged:
        # Only now are the findings genuinely fixed. Closing them before the
        # merge is what put forty findings on record as done against four PRs
        # that never landed (26 Aug 2026).
        land = sh([sys.executable, os.path.join(REPO, "scripts", "findings.py"),
                   "land", "--pr", str(args.pr)])
        out["landed"] = (land.stdout or "").strip()[-200:]
    print(json.dumps(out, indent=2))
    return 0


def main():
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
