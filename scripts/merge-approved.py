#!/usr/bin/env python3
"""Merge what Kevin approved: every approved MERGE card, through merge-pr.py, with no model.

WHY (Kevin, 7 Oct 2026). A fix to a protected file reaches Kevin as one MERGE card
(scripts/merge_card.py, raised by fixer-merge.py on a green gate). His card says "If you
approve, the robot runs merge-pr.py and the deploy, nothing else." This is that robot, and it
does exactly that: deterministic, no Claude tokens, run from the half-hourly hand-back poll.

For each card:
  approved, open      merge-pr.py --pr N, once, behind a lock per PR and a lock for the run.
                      Green: read the merge commit, land the PR's findings (findings.py land,
                      which wakes every TOOL wall on them at the next sweep), watch the Pages
                      deploy, then close the card with `agent-dispatch.py complete --evidence`.
                      Red: write the gate's last 20 lines on the card, leave the PR open and
                      put the card back in his queue; it is tried again only when he approves it
                      again (a new Approved At). The card records the PR head that was tested
                      and merge-pr.py merges that head only (--expect-head).
  edit asked for      "Approved with minor edits" with a note, or "Changes requested": a merge
                      card cannot make an edit, so nothing merges; the change goes to the fixer
                      as a HIGH finding and the card goes back to his queue saying so.
  rejected            the PR is left open and the card says so, once.
  no real approval    no Sent For Approval By, no Approved At, or one older than the card:
                      never merged (scripts/approval_evidence.py, the send paths' own check).
  not a card any more its body no longer opens with the MERGE CARD line, lost the approve line or
                      its tested head, or was not sent by the Builder: never merged.

Usage:
    python3 scripts/merge-approved.py run              # work the cards now, one at a time
    python3 scripts/merge-approved.py run --detach     # the poll's form: queue it through job-queue.py
                                                       # (wrapped, behind the render), return at once
    python3 scripts/merge-approved.py list             # what it would do; writes nothing
Exit: 0 done or nothing to do, 1 a card failed (red gate, an error), 2 the card read failed.
"""

import argparse
import fcntl
import json
import os
import signal
import subprocess
import sys
import time
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import merge_card  # noqa: E402
from approval_evidence import approval_evidence_problem  # noqa: E402

STATE_DIR = os.environ.get("MERGE_APPROVED_DIR") or os.path.expanduser("~/knowledge-os/logs/merge-approved")
# launchd's PATH is /usr/bin:/bin:/usr/sbin:/sbin and gh lives in ~/tools/bin, so every gh call
# (here and in merge-pr.py, which inherits this) would die "command not found". Node comes on
# PATH from scripts/agent-tools.sh, which the hand-back poll sources first.
for _d in (os.path.expanduser("~/tools/bin"),):
    if os.path.isdir(_d) and _d not in os.environ.get("PATH", "").split(os.pathsep):
        os.environ["PATH"] = _d + os.pathsep + os.environ.get("PATH", "")
ATTEMPTS = "attempts.json"
MERGE_TIMEOUT = 45 * 60          # merge-pr.py takes 5 to 15 minutes; its own suites cap at 30
PAGES_WORKFLOW = "253912194"     # pages-build-deployment (memory reference_deploy_poll.md)
DEPLOY_WAIT = 15 * 60
DEPLOY_POLL = 20
# Two red gates on the same code and the robot stops re-running it (review, 7 Oct 2026).
RED_LIMIT = 2
SESSION_TASK = "PR #%d failed its gate twice on this code; it needs a fix in a working session before it can merge."
SESSION_APPROVE = ("nothing runs: the robot will not re-test this code. When the fix is pushed, the card comes back "
                   "for the new code. Reject leaves the PR open.")
# The queued run (job-queue.py run merge-approved): its process id, so the poll never queues two.
QUEUED_PID = "queued.pid"
QUEUE_LEASE_MIN = 60
# Written once on a card, so a re-run never stacks the same line.
REJECTED_MARK = "MERGE CARD REJECTED:"
EDIT_MARK = "MERGE CARD NOT MERGED:"


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def sh(args, timeout=120):
    return subprocess.run(args, capture_output=True, text=True, timeout=timeout, cwd=REPO)


def py(script, *args, timeout=300):
    return sh([sys.executable, os.path.join(HERE, script)] + list(args), timeout=timeout)


# ─── state: what was tried, so a red PR is not re-run every half hour ─────

def load_attempts():
    try:
        with open(os.path.join(STATE_DIR, ATTEMPTS)) as fh:
            v = json.load(fh)
        return v if isinstance(v, dict) else {}
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as e:
        # Unreadable is not "never tried": say so, and treat every card as untried, which at
        # worst runs a gate once more. Never the other way round.
        print("WARNING: %s unreadable (%s); every card counts as untried" % (ATTEMPTS, e), file=sys.stderr)
        return {}


def save_attempts(att):
    """Atomic: a temp file renamed over the real one (python-scripts.md lock lesson)."""
    os.makedirs(STATE_DIR, exist_ok=True)
    tmp = os.path.join(STATE_DIR, ATTEMPTS + ".tmp-%d" % os.getpid())
    with open(tmp, "w") as fh:
        json.dump(att, fh, indent=1)
    os.replace(tmp, os.path.join(STATE_DIR, ATTEMPTS))


class Lock:
    """An exclusive, non-blocking flock on STATE_DIR/<name>. `held` says whether we got it."""

    def __init__(self, name):
        os.makedirs(STATE_DIR, exist_ok=True)
        self.fh = open(os.path.join(STATE_DIR, name), "a")
        try:
            fcntl.flock(self.fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.held = True
        except OSError:
            self.held = False

    def release(self):
        if self.held:
            fcntl.flock(self.fh, fcntl.LOCK_UN)
            self.held = False
        self.fh.close()


# ─── what each card needs ──────────────────────────────────────────────────

def plan(card, attempts):
    """(action, why) for one card. Pure: the whole decision, so a test can reach it."""
    pr, outcome, status = card["pr"], card["outcome"], card["status"]
    if status == "Completed":
        if outcome == "Rejected" and REJECTED_MARK not in card["notes"]:
            return "note-rejected", "Kevin rejected it"
        return "skip", "closed"
    if outcome == "Changes requested" or (outcome == "Approved with minor edits" and card["feedback"].strip()):
        return "note-edit", "an edit was asked for"
    if outcome not in merge_card.APPROVED:
        return "skip", "waiting for Kevin"
    # The card must still BE the card fixer-merge.py raised: a name kept over a DECIDE: or a
    # CLOSE PROPOSAL body would turn his "yes" to that into a merge (review, 7 Oct 2026).
    last = attempts.get(str(pr)) or {}
    if last.get("result") == "red" and int(last.get("reds") or 0) >= RED_LIMIT and last.get("head") == card["head"]:
        # The gate failed twice on this very code: no re-approval re-runs it (review, 7 Oct 2026).
        # A new head (the fix pushed, the card refreshed) starts the count again.
        return "needs-session", "the gate failed %d times on %s" % (int(last["reds"]), (card["head"] or "?")[:12])
    if last.get("result") in ("red", "error") and last.get("approvedAt") == card["approvedAt"]:
        if not last.get("back"):
            # Tried, but the card never reached his queue again (a failed write): send it back
            # now, or it would wait for an approval he cannot give (review, 7 Oct 2026).
            return "send-back", "tried at %s (%s); the card is not back in Kevin's queue yet" % (last.get("at", "?"), last.get("result"))
        return "skip", "tried at %s (%s); waiting for Kevin to approve it again" % (last.get("at", "?"), last.get("result"))
    body = merge_card.card_body_problem(card)
    if body and merge_card.card_body_problem(dict(card, head="x")) == "":
        # Only the tested head is missing: the card cannot be merged safely. Back to Kevin, saying so.
        return "send-back", "the card records no tested head"
    if body:
        return "skip", "not a MERGE card any more: " + body
    problem = approval_evidence_problem(card.get("fields") or {}, card.get("createdTime") or "")
    if problem:
        return "skip", "not a real approval: " + problem
    return "merge", "approved"


def annotate(task, note):
    r = py("agent-dispatch.py", "annotate", task, "--note", note)
    if r.returncode != 0:
        raise RuntimeError("annotate %s failed: %s" % (task, (r.stderr or r.stdout or "").strip()[-200:]))


def back_to_kevin(card, task_line, approve_line, clear_feedback=False):
    """The card back in his approval queue, saying what happened, so a card that did not merge is
    never stranded at Status Today where nothing shows it (review, 7 Oct 2026). His earlier
    Approved At stays as the record; a new approval writes a new one, which is what a retry needs."""
    merge_card.patch_card(card["id"], {
        merge_card.F["status"]: "Approval",
        merge_card.F["approvalOutcome"]: None,
        merge_card.PLAIN_SUMMARY: "TASK: %s\nIF YOU APPROVE: %s" % (task_line, approve_line),
        # An edit note already passed to the fixer is cleared, or his next plain approval would read
        # it as a new edit request (it stays in Feedback History and on the card's Notes).
        **({merge_card.F["approvalFeedback"]: None} if clear_feedback else {}),
    })


def file_finding(title, detail, fix, where):
    """A HIGH finding for the fixer (the cap never refuses high). Returns findings.py's words.
    WHERE names the PR and its branch, never this script (review, 7 Oct 2026)."""
    r = py("findings.py", "add", "--routine", "merge-approved", "--severity", "high", "--touches-code",
           "--title", title[:160], "--where", where[:300],
           "--detail", detail[:1500], "--fix", fix)
    return ((r.stdout or r.stderr or "").strip().splitlines() or [""])[0][:120]


def pr_state(pr):
    """(state, merge commit sha, head sha) from GitHub, or raises with gh's words (a PR that does
    not exist)."""
    r = sh(["gh", "pr", "view", str(pr), "--json", "state,mergeCommit,headRefOid"])
    if r.returncode != 0:
        raise RuntimeError("gh cannot read PR #%d: %s" % (pr, (r.stderr or "").strip()[:200]))
    v = json.loads(r.stdout or "{}")
    return v.get("state") or "", ((v.get("mergeCommit") or {}).get("oid") or ""), (v.get("headRefOid") or "")


def run_merge_pr(pr, head, dry_run=False):
    """merge-pr.py on PR at HEAD only (with dry_run, the gate alone: it never merges). It cleans
    up its worktree, server and port on TERM, never on KILL, so a run past MERGE_TIMEOUT gets TERM
    and a grace before KILL (review, 7 Oct 2026)."""
    args = [sys.executable, os.path.join(HERE, "merge-pr.py"), "--pr", str(pr), "--expect-head", head] + \
        (["--dry-run"] if dry_run else [])
    p = subprocess.Popen(args, cwd=REPO, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                         start_new_session=True)
    try:
        out, err = p.communicate(timeout=MERGE_TIMEOUT)
        return subprocess.CompletedProcess(args, p.returncode, out, err)
    except subprocess.TimeoutExpired:
        os.killpg(p.pid, signal.SIGTERM)
        try:
            out, err = p.communicate(timeout=120)
        except subprocess.TimeoutExpired:
            os.killpg(p.pid, signal.SIGKILL)
            out, err = p.communicate()
        return subprocess.CompletedProcess(args, 124, out, (err or "") + "\nstopped after %d minutes" % (MERGE_TIMEOUT // 60))


def deploy_state(sha, wait=DEPLOY_WAIT, poll=DEPLOY_POLL, clock=time.time, sleep=time.sleep):
    """Whether GitHub Pages deployed SHA: 'live', 'failed (<why>)' or 'not confirmed in N minutes'.
    A run cancelled because a newer push superseded it counts once a newer run succeeds."""
    end = clock() + wait
    while True:
        r = sh(["gh", "run", "list", "--workflow", PAGES_WORKFLOW, "--branch", "main", "--limit", "10",
                "--json", "headSha,status,conclusion,createdAt"])
        runs = []
        if r.returncode == 0:
            try:
                runs = json.loads(r.stdout or "[]")
            except ValueError:
                runs = []
        mine = [x for x in runs if str(x.get("headSha", "")).startswith(sha)]
        if mine and mine[0].get("status") == "completed":
            c = mine[0].get("conclusion")
            if c == "success":
                return "live"
            if c != "cancelled":
                return "failed (%s)" % c
            newer = [x for x in runs if x.get("createdAt", "") > mine[0].get("createdAt", "")
                     and x.get("status") == "completed" and x.get("conclusion") == "success"]
            if newer:
                return "live (through a newer deploy)"
        if clock() >= end:
            return "not confirmed in %d minutes" % (wait // 60)
        sleep(poll)


def last_lines(text, n=20):
    lines = [ln for ln in str(text or "").splitlines() if ln.strip()]
    return "\n".join(lines[-n:])


def merge_one(card, attempts):
    """Merge one approved card. Returns a result dict; never raises."""
    pr, task = card["pr"], card["id"]
    lock = Lock("pr-%d.lock" % pr)
    if not lock.held:
        return {"pr": pr, "task": task, "result": "busy", "why": "another run is merging this PR"}
    try:
        return _merge_locked(card, attempts)
    except Exception as e:  # noqa: BLE001 — a broken step is a failed card, written on it
        return fail(card, attempts, "error", "the merge run broke on PR #%d: %s: %s" % (pr, type(e).__name__, str(e)[:200]))
    finally:
        lock.release()


def _merge_locked(card, attempts):
    """The merge itself, under the PR's lock. A PR merged by hand is completed, never re-run."""
    pr, task = card["pr"], card["id"]
    try:
        state, sha, head = pr_state(pr)
    except Exception as e:  # noqa: BLE001 — a PR that does not exist lands here
        return fail(card, attempts, "error", "PR #%d could not be read, so nothing was merged: %s" % (pr, e))
    if state == "MERGED" and sha:
        gate_note = "already merged on GitHub (merged outside this run)"
    elif state != "OPEN":
        return fail(card, attempts, "error", "PR #%d is %s, not open, so nothing was merged." % (pr, state or "unknown"))
    elif not head or not head.startswith(card["head"]):
        return changed(card, attempts, head)
    else:
        r = run_merge_pr(pr, card["head"])
        try:
            res = json.loads(r.stdout or "{}")
        except ValueError:
            res = {}
        if r.returncode != 0 or not res.get("merged"):
            # A merge that landed just before a timeout is still a merge: ask GitHub, never assume.
            state, sha, _ = pr_state(pr)
            if state != "MERGED" or not sha:
                tail = last_lines((r.stderr or "") + "\n" + "why: " + str(res.get("why") or (r.stdout or "")[-300:]))
                return fail(card, attempts, "red", "merge-pr.py did not merge PR #%d (exit %d). Its last lines:\n%s"
                            % (pr, r.returncode, tail))
            gate_note = "merged, though merge-pr.py exited %d" % r.returncode
        else:
            state, sha, _ = pr_state(pr)
            if state != "MERGED" or not sha:
                return fail(card, attempts, "error", "merge-pr.py said merged but GitHub says PR #%d is %s" % (pr, state))
            gate_note = "merge-pr.py: " + str(res.get("why") or "merged")[:200]
    land = py("findings.py", "land", "--pr", str(pr))
    landed = (land.stdout or land.stderr or "").strip()[-200:]
    deploy = deploy_state(sha)
    if deploy.startswith("failed"):
        # Merged and landed, so the card closes; the broken deploy is its own fix (review).
        file_finding("Pages deploy %s after MERGE card PR #%d" % (deploy, pr),
                     "PR #%d merged as %s through its MERGE card, and the GitHub Pages deploy %s."
                     % (pr, sha[:12], deploy),
                     "Find why the Pages deploy failed and redeploy; the merge itself is done.",
                     "GitHub Pages deploy of %s (PR #%d)" % (sha[:12], pr))
    evidence = ("PR #%d merged as %s (%s). Findings: %s. Deploy: %s."
                % (pr, sha[:12], gate_note, landed or "none pending", deploy))
    c = py("agent-dispatch.py", "complete", task, "--evidence", evidence)
    if c.returncode != 0:
        return fail(card, attempts, "merged-open", "PR #%d merged as %s, but the card would not close: %s"
                    % (pr, sha[:12], (c.stderr or c.stdout or "").strip()[-300:]), merged=True)
    attempts[str(pr)] = {"result": "merged", "sha": sha, "approvedAt": card["approvedAt"], "at": now_iso()}
    save_attempts(attempts)
    return {"pr": pr, "task": task, "result": "merged", "sha": sha, "deploy": deploy, "findings": landed}


def send_back(card, task_line, approve_line):
    """back_to_kevin, never raising. True when the card is back in his queue."""
    try:
        back_to_kevin(card, task_line, approve_line)
        return True
    except Exception as e:  # noqa: BLE001 — reported, and plan() sends it back next run
        print("WARNING: card %s not sent back to Kevin: %s" % (card["id"], e), file=sys.stderr)
        return False


def fail(card, attempts, result, why, merged=False):
    """Write WHY on the card, record the attempt against this approval, and report it. A card that
    did not merge goes back to Kevin's queue FIRST, in its own step, so a failed note can never
    strand it; the attempt records whether it got there, and plan() retries the send-back until
    it does (review, 7 Oct 2026). One that merged but would not close stays as it is: the next
    run reads MERGED and goes straight to complete."""
    out = {"pr": card["pr"], "task": card["id"], "result": result, "why": why[:400]}
    prev = attempts.get(str(card["pr"])) or {}
    reds = (int(prev.get("reds") or 0) if prev.get("head") == card["head"] else 0) + (result == "red")
    back = False
    if not merged:
        if reds >= RED_LIMIT:
            out["needsSession"] = True
            back = send_back(card, SESSION_TASK % card["pr"], SESSION_APPROVE)
            why += (" The gate has now failed %d times on this code, so the robot will not run it again: "
                    "PR #%d needs a fix in a working session (%s)." % (reds, card["pr"], file_finding(
                        "PR #%d failed its gate %d times on its MERGE card" % (card["pr"], reds),
                        "The merge of PR #%d (head %s) failed merge-pr.py %d times. Last: %s"
                        % (card["pr"], (card["head"] or "?")[:12], reds, why[:800]),
                        "Fix the failing tests on PR #%d's own branch; fixer-merge.py merge --pr %d then "
                        "refreshes the MERGE card for the new head." % (card["pr"], card["pr"]),
                        "PR #%d (its branch), from its MERGE card" % card["pr"]) or "finding not filed"))
        else:
            back = send_back(card, "The merge of PR #%d did not go through: %s" % (card["pr"], why.splitlines()[0][:200]),
                             "the robot tries merge-pr.py on PR #%d once more, and the deploy. Reject leaves the PR open."
                             % card["pr"])
        out["backToKevin"] = back
    out["why"] = why[:700]
    attempts[str(card["pr"])] = {"result": result, "approvedAt": card["approvedAt"], "at": now_iso(), "back": back,
                                 "head": card["head"], "reds": reds}
    save_attempts(attempts)
    try:
        annotate(card["id"], ("MERGED, CARD NOT CLOSED: %s The next run closes it." if merged
                              else "MERGE NOT DONE: %s The PR is left open.") % why)
    except Exception as e:  # noqa: BLE001 — the result still says what happened
        out["annotateError"] = str(e)[:200]
        print("WARNING: %s" % e, file=sys.stderr)
    return out


def changed(card, attempts, head):
    """The PR moved after its card was raised: his approval was of the old head, so nothing merges.
    The new code is re-tested with `merge-pr.py --dry-run --expect-head <new head>`, which never
    merges (review, 7 Oct 2026: never fixer-merge.py, which merges an unprotected PR itself). Green:
    the card is rebuilt for the new head, files and result. Either way it goes back to Kevin, and
    only his next approval, of the code now on the card, can merge it."""
    pr = card["pr"]
    why = ("PR #%d changed after this card was raised (it tested %s, the PR is now at %s), so nothing was "
           "merged." % (pr, card["head"][:12], (head or "?")[:12]))
    if not head:
        return fail(card, attempts, "error", why)
    r = run_merge_pr(pr, head, dry_run=True)
    try:
        res = json.loads(r.stdout or "{}")
    except ValueError:
        res = {}
    if r.returncode == 0 and res.get("head", "").startswith(head):
        try:
            refresh_card(card, head, res)
            why += " Re-tested green on the new code; the card now shows it."
        except Exception as e:  # noqa: BLE001 — said on the card; the old head stays, so it cannot merge
            why += " Re-tested green, but the card could not be refreshed: %s" % str(e)[:160]
    else:
        why += " The new code was re-tested and is not green: %s" % last_lines(
            (r.stderr or "") + "\nwhy: " + str(res.get("why") or ""), 5).replace("\n", " | ")[:300]
    return fail(card, attempts, "error", why)


def refresh_card(card, head, res):
    """Rebuild the card's work for HEAD from GitHub and the findings queue, with the dry run's result."""
    import findings
    r = sh(["gh", "pr", "view", str(card["pr"]), "--json", "title,url,files"])
    if r.returncode != 0:
        raise RuntimeError("gh cannot read PR #%d: %s" % (card["pr"], (r.stderr or "").strip()[:160]))
    v = json.loads(r.stdout or "{}")
    files = [f.get("path") for f in v.get("files") or [] if isinstance(f, dict) and f.get("path")]
    pending = sorted((x["id"], x.get("title", "")) for x in findings.current_state().values()
                     if x.get("status") == "pending" and str(x.get("pr", "")) == str(card["pr"]))
    prot = set(merge_card.protected_paths())
    protected = [f for f in files if f in prot or any(p.endswith("/") and f.startswith(p) for p in prot)]
    gate = {"vitest": {"tail": (res.get("vitest") or {}).get("tail", "") or "green"},
            "browser": {"tail": (res.get("browser") or {}).get("tail", "") or "green"}}
    merge_card.patch_card(card["id"], {merge_card.F["agentOutput"]: merge_card.card_output(
        card["pr"], v.get("title") or "", v.get("url") or "", pending, files, protected, gate, head)})


def note_edit(card):
    """Kevin asked for a change a merge card cannot make. The change goes to the fixer as a HIGH
    finding, the card says so, and it goes back to his queue: approve merges the PR as it is,
    reject leaves it. Nothing merges on an edit request (review, 7 Oct 2026)."""
    note = " ".join(card["feedback"].split())[:600]
    if note and note in " ".join(card["notes"].split()):
        # Already passed on (a run that filed it then failed to move the card): move it only.
        back_to_kevin(card, "You asked for a change to PR #%d. A merge card cannot make one, so it went to the fixer."
                      % card["pr"], "the robot merges PR #%d as it is now. Reject leaves the PR open." % card["pr"],
                      clear_feedback=True)
        return
    fid = file_finding("Kevin asked for a change to PR #%d" % card["pr"],
                       "On the MERGE card for PR #%d (%s) Kevin wrote: %s" % (card["pr"], card["outcome"], note or "(no note)"),
                       "Make the change as a new commit on PR #%d's own branch (gh pr checkout %d), never a new PR. "
                       "fixer-merge.py merge --pr %d then refreshes the MERGE card for the new head." % ((card["pr"],) * 3),
                       "PR #%d (its branch), from its MERGE card" % card["pr"])
    annotate(card["id"], "%s Kevin's note asks for a change (%s), which a merge card cannot make, so nothing "
                         "merged. It went to the fixer (%s). Note: %s"
             % (EDIT_MARK, card["outcome"], fid or "finding not filed", note))
    back_to_kevin(card, "You asked for a change to PR #%d. A merge card cannot make one, so it went to the fixer."
                  % card["pr"], "the robot merges PR #%d as it is now. Reject leaves the PR open." % card["pr"],
                      clear_feedback=True)


def cmd_run(args):
    run_lock = Lock("run.lock")
    if not run_lock.held:
        print(json.dumps({"busy": True, "why": "another merge-approved run is working"}))
        return 0
    try:
        try:
            control = merge_card.read_tasks("NOT({Status}='Completed')", [merge_card.F["name"]], max_records=1)
            cards = merge_card.list_cards()
        except Exception as e:  # noqa: BLE001 — NOT CHECKED, never "no cards"
            print(json.dumps({"error": "NOT CHECKED: the MERGE card read failed: %s" % str(e)[:300]}))
            return 2
        if not control:
            print(json.dumps({"error": "NOT CHECKED: the control read found no open task at all, so the "
                                       "card read is blind, not empty"}))
            return 2
        attempts = load_attempts()
        done, failed = [], 0
        for card in sorted(cards, key=lambda c: c["pr"]):
            action, why = plan(card, attempts)
            if args.dry_run or action == "skip":
                done.append({"pr": card["pr"], "task": card["id"], "action": action, "why": why})
                continue
            if action == "needs-session":
                # Approved again after two reds on the same code: back to his queue, saying so.
                ok = send_back(card, SESSION_TASK % card["pr"], SESSION_APPROVE)
                failed += not ok
                done.append({"pr": card["pr"], "task": card["id"], "action": action, "ok": ok, "why": why})
                continue
            if action == "send-back":
                ok = send_back(card, "The merge of PR #%d did not go through (%s)." % (card["pr"], why[:160]),
                               "the robot tries merge-pr.py on PR #%d once more, and the deploy. Reject leaves the PR "
                               "open." % card["pr"])
                if ok:
                    last = attempts.get(str(card["pr"])) or {}
                    attempts[str(card["pr"])] = dict(last, back=True, approvedAt=last.get("approvedAt", card["approvedAt"]),
                                                     result=last.get("result", "error"), at=last.get("at", now_iso()))
                    save_attempts(attempts)
                failed += not ok
                done.append({"pr": card["pr"], "task": card["id"], "action": action, "ok": ok, "why": why})
                continue
            if action in ("note-rejected", "note-edit"):
                try:
                    if action == "note-rejected":
                        annotate(card["id"], "%s Kevin rejected the merge card, so PR #%d is left open and "
                                             "nothing was merged." % (REJECTED_MARK, card["pr"]))
                    else:
                        note_edit(card)
                    done.append({"pr": card["pr"], "task": card["id"], "action": action})
                except Exception as e:  # noqa: BLE001
                    failed += 1
                    done.append({"pr": card["pr"], "task": card["id"], "action": action, "error": str(e)[:200]})
                continue
            res = merge_one(card, attempts)
            failed += res["result"] in ("red", "error", "merged-open")
            done.append(dict(res, action="merge"))
        print(json.dumps({"cards": len(cards), "done": done, "dryRun": bool(args.dry_run)}, indent=1))
        return 1 if failed else 0
    finally:
        run_lock.release()


def queued_alive():
    """The pid of a queued or running merge-approved job, or None."""
    try:
        with open(os.path.join(STATE_DIR, QUEUED_PID)) as fh:
            pid = int(fh.read().strip())
        os.kill(pid, 0)
        return pid
    except (OSError, ValueError):
        return None


def cmd_detach(args):
    """Queue a run through job-queue.py (wrapped, lease QUEUE_LEASE_MIN) and return at once, so
    the half-hourly poll is never held by a 15-minute gate and a merge never overlaps the night
    render (review, 7 Oct 2026: a merge is never time-critical). Starts nothing when there is
    nothing to merge, or a run is already queued or working."""
    pid = queued_alive()
    probe = Lock("run.lock")
    busy = not probe.held
    probe.release()
    if busy or pid:
        print(json.dumps({"busy": True, "queued": pid}))
        return 0
    try:
        control = merge_card.read_tasks("NOT({Status}='Completed')", [merge_card.F["name"]], max_records=1)
        cards = merge_card.list_cards()
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"error": "NOT CHECKED: the MERGE card read failed: %s" % str(e)[:300]}))
        return 2
    if not control:
        # A read that reaches no task at all is blind: "no cards" from it would be a silent zero.
        print(json.dumps({"error": "NOT CHECKED: the control read found no open task at all, so the "
                                   "card read is blind, not empty"}))
        return 2
    attempts = load_attempts()
    todo = [c["pr"] for c in cards if plan(c, attempts)[0] != "skip"]
    if not todo:
        print(json.dumps({"cards": len(cards), "todo": []}))
        return 0
    os.makedirs(STATE_DIR, exist_ok=True)
    log = open(os.path.join(STATE_DIR, "runs.log"), "a")
    log.write("===== merge-approved queued %s for PR %s =====\n" % (now_iso(), todo))
    log.flush()
    p = subprocess.Popen([sys.executable, os.path.join(HERE, "job-queue.py"), "run", "merge-approved",
                          "--lease", str(QUEUE_LEASE_MIN), "--", sys.executable, os.path.abspath(__file__), "run"],
                         cwd=REPO, stdout=log, stderr=log, stdin=subprocess.DEVNULL, start_new_session=True)
    tmp = os.path.join(STATE_DIR, QUEUED_PID + ".tmp")
    with open(tmp, "w") as fh:
        fh.write(str(p.pid))
    os.replace(tmp, os.path.join(STATE_DIR, QUEUED_PID))
    print(json.dumps({"cards": len(cards), "todo": todo, "queued": p.pid}))
    return 0


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = p.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run")
    r.add_argument("--detach", action="store_true")
    r.add_argument("--dry-run", action="store_true")
    sub.add_parser("list")
    a = p.parse_args(argv)
    if a.cmd == "list":
        a.dry_run = True
        return cmd_run(a)
    if a.detach:
        return cmd_detach(a)
    return cmd_run(a)


if __name__ == "__main__":
    sys.exit(main())
