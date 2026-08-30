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

Usage:
    fixer-merge.py check --pr 123          # decide, run nothing
    fixer-merge.py merge --pr 123          # gate + merge, or refuse loudly
Exit: 0 merged or safely refused-and-reported, 1 the gate itself broke.
"""

import argparse
import json
import os
import subprocess
import sys

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
)


def sh(args, cwd=REPO, timeout=1800):
    return subprocess.run(args, cwd=cwd, capture_output=True, text=True,
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


def run_gate():
    """Both halves. A green vitest with a red browser suite is not green."""
    out = {}
    v = sh(["npx", "vitest", "run"])
    out["vitest"] = {"ok": v.returncode == 0,
                     "tail": (v.stdout or v.stderr or "").strip()[-400:]}
    if not out["vitest"]["ok"]:
        return False, out
    b = sh(["npx", "playwright", "test", "tests/sync-invariants/",
            "--reporter=dot"])
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
    ok, gate = run_gate()
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
