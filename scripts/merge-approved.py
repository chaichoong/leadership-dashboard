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
                      Red: write the gate's last 20 lines on the card and leave the PR open. His
                      approval STANDS (13 Nov 2026): the card is not sent back to his queue, and
                      the robot tries again by itself, no sooner than RED_RETRY_HOURS after the
                      last red, at most RED_MAX reds on the same head. After the last one it files
                      ONE high finding and the card rests out of his queue until the PR's head
                      changes; a new head goes back to him through changed(). The card records the
                      PR head that was tested and merge-pr.py merges that head only (--expect-head).
  merged on GitHub    an open card whose PR is already merged lands its findings and is closed with
                      the merge commit when approved; with no verdict, `complete` refuses it, so it
                      is noted once and its approve line says Approve only closes the card.
  edit asked for      "Approved with minor edits" with a note, or "Changes requested": a merge
                      card cannot make an edit, so nothing merges; the change goes to the fixer
                      as a HIGH finding and the card goes back to his queue saying so.
  rejected            the PR is left open and the card says so, once.
  PR closed unmerged  closed on GitHub without merging (14 Nov 2026): nothing can merge, so the robot
                      closes the card itself, once, whatever the verdict, with a dated Notes line, and
                      puts the findings left pending on that PR back in the fixer's queue
                      (findings.py reopen --force). Never sent back: Approve would run nothing.
  PR moved            the head changed after the card was raised: the new code is dry-run tested.
                      Green and the card refreshed: back to Kevin, whose Approve now merges the new
                      head. Anything else (not green, head unreadable, refresh failed) is NOT sent
                      back: the card rests and the robot re-tests by itself on the red clock, at most
                      RED_MAX times on that new head, then ONE stop finding (14 Nov 2026).
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
# A red gate never sends the card back to Kevin (13 Nov 2026). PR #890's card was approved 33
# times in a week and nothing ran: both reds were tests the PR never touched, so the "fix on its
# own branch" the card waited for could never come. His approval of a tested head stands; the
# robot retries by itself on a clock, and stops after RED_MAX reds on the same head.
RED_RETRY_HOURS = merge_card.RED_RETRY_HOURS   # 6; one source, read by agent-dispatch.py's wall row too
RED_MAX = merge_card.RED_MAX                   # 4
# The clock plan() and fail() read. A module name, so a test can move time without touching
# the time module every other caller shares.
clock = time.time
# The queued run (job-queue.py run merge-approved): its process id, so the poll never queues two.
QUEUED_PID = "queued.pid"
QUEUE_LEASE_MIN = 60
# attempts.json results this script writes beside red/error/merged (14 Nov 2026).
CLOSED_RESULT = "closed-unmerged"   # the PR was closed without merging; the robot closed the card
MOVED_RESULT = "moved"              # the PR moved and its new head is not yet a card Kevin can approve
# Written once on a card, so a re-run never stacks the same line.
REJECTED_MARK = "MERGE CARD REJECTED:"
EDIT_MARK = "MERGE CARD NOT MERGED:"


def now_iso(now=None):
    return datetime.fromtimestamp(clock() if now is None else now, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _epoch(iso):
    """Seconds for an ISO time this script wrote, or None for anything it cannot read."""
    try:
        return datetime.strptime(str(iso or "")[:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc).timestamp()
    except ValueError:
        return None


def _count(entry, key):
    try:
        return int((entry or {}).get(key) or 0)
    except (TypeError, ValueError):
        return 0


def _reds(entry):
    return _count(entry, "reds")


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

def red_rest(card, last, now):
    """(action, why) while a red on the card's own head is resting, or None to go ahead.
    Pure. A red on another head, or an entry from before 13 Nov 2026 with no head, never rests."""
    if last.get("result") != "red" or not card["head"] or last.get("head") != card["head"]:
        return None
    reds, head = _reds(last), card["head"][:12]
    if reds >= RED_MAX:
        if not last.get("finding"):
            return "file-finding", "the gate failed %d times on %s and the finding is not filed yet" % (reds, head)
        return "skip", ("resting: the gate failed %d times on %s, so the robot stopped retrying (%s); a new "
                        "head brings the card back" % (reds, head, last["finding"]))
    if last.get("approvedAt") and card["approvedAt"] and card["approvedAt"] != last["approvedAt"]:
        return None    # he approved again since the red: his newer press runs now, within the cap
    since = _epoch(last.get("lastRedAt") or last.get("at"))
    if since is not None and now < since + RED_RETRY_HOURS * 3600:
        return "skip", ("red %d of %d on %s; his approval stands and the robot tries again by itself after %s"
                        % (reds, RED_MAX, head, now_iso(since + RED_RETRY_HOURS * 3600)))
    return None


def moved_rest(card, last, live_head, now):
    """(action, why) while re-tests of a MOVED head are resting, or None to go ahead. Pure.
    Keyed on the new head (newHead), so a further push starts the count again; "" is a head
    that could not be read. A card refreshed to that head is no longer moved: its verdict decides."""
    if last.get("result") != MOVED_RESULT or (last.get("newHead") or "") != (live_head or ""):
        return None
    if live_head and card["head"] and live_head.startswith(card["head"]):
        return None
    tries, new = _count(last, "movedTries"), (live_head or "an unreadable head")[:12]
    if tries >= RED_MAX:
        if not last.get("finding"):
            return "file-finding", ("the new code (%s) failed %d re-tests and the finding is not filed yet"
                                    % (new, tries))
        return "skip", ("resting: the PR moved to %s and that code failed %d re-tests, so the robot stopped (%s); "
                        "a new head starts again" % (new, tries, last["finding"]))
    since = _epoch(last.get("lastMovedAt") or last.get("at"))
    if since is not None and now < since + RED_RETRY_HOURS * 3600:
        return "skip", ("the PR moved to %s after the card was raised; re-test %d of %d was not a green card, so "
                        "the robot re-tests by itself after %s" % (new, tries, RED_MAX,
                                                                   now_iso(since + RED_RETRY_HOURS * 3600)))
    return None


def plan(card, attempts, now=None):
    """(action, why) for one card. Pure: the whole decision, so a test can reach it. NOW is the
    clock (seconds); the card may carry prState/prHead, read from GitHub by attach_live."""
    now = clock() if now is None else now
    pr, outcome, status = card["pr"], card["outcome"], card["status"]
    if status == "Completed":
        if outcome == "Rejected" and REJECTED_MARK not in card["notes"]:
            return "note-rejected", "Kevin rejected it"
        return "skip", "closed"
    last = attempts.get(str(pr)) or {}
    live_state, live_head = card.get("prState") or "", card.get("prHead") or ""
    if live_state == "MERGED" and outcome not in merge_card.APPROVED:
        # Merged outside the card: nothing for his verdict to start (13 Nov 2026). Noted once.
        if last.get("result") == "merged-elsewhere" and last.get("noted"):
            return "skip", "PR #%d is already merged; noted, and Approve only closes the card" % pr
        return "close-merged", "PR #%d is already merged on GitHub" % pr
    if live_state == "CLOSED":
        # Closed without merging (14 Nov 2026): no verdict can merge it, so the card is closed by
        # the robot, once, never sent back with an Approve that runs nothing.
        if last.get("result") == CLOSED_RESULT:
            return "skip", "PR #%d was closed without merging; the robot closed the card at %s" % (pr, last.get("at", "?"))
        return "close-unmerged", "PR #%d was closed on GitHub without merging" % pr
    if outcome == "Changes requested" or (outcome == "Approved with minor edits" and card["feedback"].strip()):
        return "note-edit", "an edit was asked for"
    if outcome not in merge_card.APPROVED:
        return "skip", "waiting for Kevin"
    moved = bool(live_head and card["head"] and not live_head.startswith(card["head"]))
    if live_state != "MERGED":
        rest = moved_rest(card, last, live_head, now) or (None if moved else red_rest(card, last, now))
        if rest:
            return rest
    if last.get("result") == "error" and last.get("approvedAt") == card["approvedAt"]:
        if not last.get("back"):
            # Tried, but the card never reached his queue again (a failed write): send it back
            # now, or it would wait for an approval he cannot give (review, 7 Oct 2026).
            return "send-back", "tried at %s (%s); the card is not back in Kevin's queue yet" % (last.get("at", "?"), last.get("result"))
        return "skip", "tried at %s (%s); waiting for Kevin to approve it again" % (last.get("at", "?"), last.get("result"))
    # The card must still BE the card fixer-merge.py raised: a name kept over a DECIDE: or a
    # CLOSE PROPOSAL body would turn his "yes" to that into a merge (review, 7 Oct 2026).
    body = merge_card.card_body_problem(card)
    if body and merge_card.card_body_problem(dict(card, head="x")) == "":
        # Only the tested head is missing: the card cannot be merged safely. Back to Kevin, saying so.
        return "send-back", "the card records no tested head"
    if body:
        return "skip", "not a MERGE card any more: " + body
    problem = approval_evidence_problem(card.get("fields") or {}, card.get("createdTime") or "")
    if problem:
        return "skip", "not a real approval: " + problem
    if last.get("result") == "red" and last.get("head") == card["head"] and card["head"]:
        return "merge", "approved; retry after red %d of %d" % (_reds(last), RED_MAX)
    return "merge", "approved"


def attach_live(cards):
    """Each open card's PR state and head from GitHub, on the card (prState, prHead), so plan()
    can see a PR merged outside its card or moved under a resting one. A failed read is said on
    the card (prReadError) and plan() decides as it did before."""
    for c in cards:
        if c["status"] == "Completed":
            continue
        try:
            c["prState"], _, c["prHead"] = pr_state(c["pr"])
        except Exception as e:  # noqa: BLE001 — NOT CHECKED for this card, never "not merged"
            c["prReadError"] = str(e)[:200]
    return cards


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


def file_finding(title, detail, fix, where, holds_pr=None):
    """A HIGH finding for the fixer (the cap never refuses high). Returns findings.py's words.
    WHERE names the PR and its branch, never this script (review, 7 Oct 2026). HOLDS_PR marks a
    stop finding: it holds that PR's MERGE card, so the worklist ranks it by what that PR unblocks."""
    r = py("findings.py", "add", "--routine", "merge-approved", "--severity", "high", "--touches-code",
           "--title", title[:160], "--where", where[:300],
           "--detail", detail[:1500], "--fix", fix,
           *(["--holds-merge-pr", str(holds_pr)] if holds_pr else []))
    if r.returncode != 0:
        # Not filed is "", never findings.py's error words passed off as a finding id.
        print("WARNING: finding not filed: %s" % (r.stderr or r.stdout or "").strip()[-200:], file=sys.stderr)
        return ""
    return ((r.stdout or "").strip().splitlines() or [""])[0][:120]


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
    elif state == "CLOSED":
        try:
            return _close_unmerged_locked(card, attempts)
        except Exception as e:  # noqa: BLE001 — never fail() here: that sends a closed PR's card back to Kevin
            return {"pr": pr, "task": task, "result": "error",
                    "why": "PR #%d is closed unmerged; closing its card failed: %s: %s" % (pr, type(e).__name__, str(e)[:200])}
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
    # The card is closed and the findings have landed, so the workspace is debris.
    # Last, and after the card: a teardown that broke must never cost the merge.
    workspace = teardown_worktree(pr)
    return {"pr": pr, "task": task, "result": "merged", "sha": sha, "deploy": deploy,
            "findings": landed, "workspace": workspace}


# ─── tear the merged workspace down ───────────────────────────────────────
#
# Finding 20261109-queue-fixer-1250. queue-fixer STEP 5b removes its workspace
# after a SELF-merge, and a protected PR never self-merges: it waits for Kevin's
# MERGE card and lands here instead, so nothing ever took its worktree down. By
# 9 Nov 2026 five clean protected workspaces had piled up in .claude/worktrees,
# each a checkout something could be run from by mistake (finding
# 20260909-queue-fixer-504 is exactly that: content-engine ran from a worktree
# five commits behind main).
#
# worktree.sh done already REFUSES while anything would be lost — uncommitted
# files, commits that exist nowhere else, a branch not merged into origin/main —
# so its refusal is reported, never forced past. Nothing here ever passes
# --force.
# content-engine-runtime is pinned to main for the nightly jobs, and main-checkout
# is the branch the main checkout itself sits on. Neither is ever removed, whatever
# a branch name implies.
PINNED_WORKTREES = ("content-engine-runtime", "main-checkout", "main")


def branch_topic(branch):
    """The worktree topic a branch belongs to, or "" when it is not one of ours.

    worktree.sh names the branch <kind>/<topic>, so the topic is what follows the
    first slash. A branch with no slash (main, a hand-made branch) gets nothing:
    guessing a topic is how the pinned main worktree would be removed."""
    branch = (branch or "").strip()
    if "/" not in branch:
        return ""
    topic = branch.split("/", 1)[1].strip().strip("/")
    if not topic or "/" in topic or topic in PINNED_WORKTREES:
        return ""
    return topic


def teardown_worktree(pr):
    """Remove the merged PR's workspace. Returns a line for the result, never raises."""
    try:
        r = sh(["gh", "pr", "view", str(pr), "--json", "headRefName", "-q", ".headRefName"])
        branch = (r.stdout or "").strip() if r.returncode == 0 else ""
        topic = branch_topic(branch)
        if not topic:
            return "no workspace to remove (branch %r)" % (branch or "unreadable")
        path = os.path.join(REPO, ".claude", "worktrees", topic)
        if not os.path.isdir(path):
            return "no workspace for %s" % topic
        d = sh([os.path.join(REPO, "scripts", "worktree.sh"), "done", topic], timeout=300)
        if d.returncode != 0:
            # A refusal is information: something would be lost, so it stays.
            return "workspace %s kept: %s" % (
                topic, ((d.stderr or d.stdout or "").strip()[-200:] or "worktree.sh refused"))
        return "workspace %s removed" % topic
    except Exception as e:  # noqa: BLE001 — teardown never fails a merge that landed
        return "workspace not removed: %s: %s" % (type(e).__name__, str(e)[:120])


def send_back(card, task_line, approve_line):
    """back_to_kevin, never raising. True when the card is back in his queue."""
    try:
        back_to_kevin(card, task_line, approve_line)
        return True
    except Exception as e:  # noqa: BLE001 — reported, and plan() sends it back next run
        print("WARNING: card %s not sent back to Kevin: %s" % (card["id"], e), file=sys.stderr)
        return False


def stop_finding(card, reds, why, moved=False):
    """The ONE high finding filed when the robot stops retrying a head. It quotes the failing gate
    lines and does not guess where the failure is: on PR #890 both reds were tests the PR never
    touched (13 Nov 2026). MOVED: the head is one the PR moved to after Kevin approved an older one,
    re-tested by dry run (14 Nov 2026). Returns findings.py's id line, or "" when it was not filed."""
    pr = card["pr"]
    what = ("PR #%d moved after Kevin approved its MERGE card, and its new code (head %s) was re-tested %d times, "
            "at least %d hours apart, without a green card he could approve" if moved else
            "Kevin approved the MERGE card for PR #%d (head %s). merge-pr.py failed %d times on that head, at least "
            "%d hours apart")
    return file_finding(
        ("PR #%d's new code failed %d re-tests after its MERGE card; the robot stopped" if moved else
         "PR #%d failed its gate %d times on its MERGE card; the robot stopped retrying") % (pr, reds),
        (what + ", so the robot stopped retrying it. Whether the failure is in this PR's own code or in "
         "tests it does not touch is not known here: read the gate lines. Last:\n%s")
        % (pr, (card["head"] or "?")[:12], reds, RED_RETRY_HOURS, why[:1000]),
        "Fix it in a working session. If the failing lines are PR #%d's own code, push the fix to its branch "
        "(fixer-merge.py merge --pr %d refreshes the card for the new head). If they are tests the PR does not "
        "touch, fix main in its own PR, then update PR #%d's branch from main so its head changes and the card "
        "comes back to Kevin for the new code." % ((pr,) * 3),
        "PR #%d (its branch), from its MERGE card" % pr, holds_pr=pr)


def fail(card, attempts, result, why, merged=False):
    """Write WHY on the card, record the attempt, and report it.
    A RED gate leaves his approval standing (13 Nov 2026): the card stays where it is, and the
    robot retries by itself (plan() reads the clock) until RED_MAX reds on this head, when it
    files ONE finding and the card rests until the head changes. Any OTHER failure goes back to
    his queue FIRST, in its own step, so a failed note can never strand it; the attempt records
    whether it got there, and plan() retries the send-back until it does (review, 7 Oct 2026).
    One that merged but would not close stays as it is: the next run reads MERGED and goes
    straight to complete."""
    out = {"pr": card["pr"], "task": card["id"], "result": result, "why": why[:400]}
    prev = attempts.get(str(card["pr"])) or {}
    same_head = bool(card["head"]) and prev.get("head") == card["head"]
    reds = (_reds(prev) if same_head else 0) + (result == "red")
    at = clock()
    entry = {"result": result, "approvedAt": card["approvedAt"], "at": now_iso(at), "back": False,
             "head": card["head"], "reds": reds}
    if result == "red" and not merged:
        entry["lastRedAt"] = entry["at"]
        if reds >= RED_MAX:
            filed = prev.get("finding") if same_head and prev.get("finding") else stop_finding(card, reds, why)
            entry["finding"] = filed
            out["stopped"] = True
            why += (" The gate has now failed %d times on this code (head %s), so the robot has stopped retrying it "
                    "(%s). The card rests out of Kevin's queue until the PR's head changes."
                    % (reds, (card["head"] or "?")[:12], filed or "finding not filed; the next run files it"))
        else:
            out["retryAt"] = now_iso(at + RED_RETRY_HOURS * 3600)
            why += (" Kevin's approval stands: the robot tries again by itself after %s (red %d of %d on this code)."
                    % (out["retryAt"], reds, RED_MAX))
    elif not merged:
        entry["back"] = out["backToKevin"] = send_back(
            card, "The merge of PR #%d did not go through: %s" % (card["pr"], why.splitlines()[0][:200]),
            "the robot tries merge-pr.py on PR #%d once more, and the deploy. Reject leaves the PR open." % card["pr"])
    out["why"] = why[:700]
    attempts[str(card["pr"])] = entry
    save_attempts(attempts)
    try:
        annotate(card["id"], ("MERGED, CARD NOT CLOSED: %s The next run closes it." if merged
                              else "MERGE NOT DONE: %s The PR is left open.") % why)
    except Exception as e:  # noqa: BLE001 — the result still says what happened
        out["annotateError"] = str(e)[:200]
        print("WARNING: %s" % e, file=sys.stderr)
    return out


def file_stop(card, attempts):
    """The stop finding a 4th red (or a 4th re-test of a moved head) could not file, filed now, once."""
    last = dict(attempts.get(str(card["pr"])) or {})
    gate = "(the gate lines are on the card's Notes, MERGE NOT DONE)"
    if last.get("result") == MOVED_RESULT:
        fid = stop_finding(dict(card, head=last.get("newHead") or "?"), _count(last, "movedTries"), gate, moved=True)
    else:
        fid = stop_finding(card, _reds(last), gate)
    if not fid:
        return {"pr": card["pr"], "task": card["id"], "result": "error", "why": "the stop finding was not filed"}
    attempts[str(card["pr"])] = dict(last, finding=fid)
    save_attempts(attempts)
    try:
        head = last.get("newHead") if last.get("result") == MOVED_RESULT else card["head"]
        annotate(card["id"], "MERGE NOT DONE: the robot stopped retrying PR #%d on head %s and filed %s. The PR is "
                             "left open." % (card["pr"], (head or "?")[:12], fid))
    except Exception as e:  # noqa: BLE001
        print("WARNING: %s" % e, file=sys.stderr)
    return {"pr": card["pr"], "task": card["id"], "result": "finding-filed", "finding": fid}


def close_merged(card, attempts):
    """An open card whose PR GitHub reports MERGED, with no verdict (13 Nov 2026): land its findings
    and try the same close _merge_locked runs. `agent-dispatch.py complete` refuses any task whose
    outcome is not an approval, and no verdict is ever written here, so when it refuses the card is
    noted ONCE and its approve line says what Approve does now: close the card, nothing else."""
    pr, task = card["pr"], card["id"]
    lock = Lock("pr-%d.lock" % pr)
    if not lock.held:
        return {"pr": pr, "task": task, "result": "busy", "why": "another run is working on this PR"}
    try:
        state, sha, _ = pr_state(pr)
        if state != "MERGED" or not sha:
            return {"pr": pr, "task": task, "result": "skip", "why": "GitHub no longer says merged (%s)" % state}
        land = py("findings.py", "land", "--pr", str(pr))
        landed = (land.stdout or land.stderr or "").strip()[-200:] or "none pending"
        evidence = ("PR #%d merged as %s (already merged on GitHub before the card was approved). Findings: %s."
                    % (pr, sha[:12], landed))
        c = py("agent-dispatch.py", "complete", task, "--evidence", evidence)
        if c.returncode == 0:
            attempts[str(pr)] = {"result": "merged", "sha": sha, "approvedAt": card["approvedAt"], "at": now_iso()}
            save_attempts(attempts)
            return {"pr": pr, "task": task, "result": "merged", "sha": sha, "findings": landed}
        refused = (c.stderr or c.stdout or "").strip()[-200:]
        merge_card.patch_card(task, {merge_card.PLAIN_SUMMARY: (
            "TASK: PR #%d is already merged (as %s); this card only needs closing.\n"
            "IF YOU APPROVE: the robot closes this card with the merge commit. Nothing is merged or run. "
            "Reject leaves it as it is." % (pr, sha[:12]))})
        attempts[str(pr)] = dict(attempts.get(str(pr)) or {}, result="merged-elsewhere", sha=sha, noted=True,
                                 at=now_iso())
        save_attempts(attempts)
        annotate(task, "MERGED OUTSIDE THIS CARD: PR #%d is merged on GitHub as %s. Findings: %s. The card could not "
                       "close without Kevin's verdict (%s), so Approve now only closes it." % (pr, sha[:12], landed, refused))
        return {"pr": pr, "task": task, "result": "merged-noted", "sha": sha, "findings": landed, "completeRefused": refused}
    except Exception as e:  # noqa: BLE001 — said in the run's output; the next run tries again
        return {"pr": pr, "task": task, "result": "error", "why": "%s: %s" % (type(e).__name__, str(e)[:200])}
    finally:
        lock.release()


def changed(card, attempts, head):
    """The PR moved after its card was raised: his approval was of the old head, so nothing merges.
    The new code is re-tested with `merge-pr.py --dry-run --expect-head <new head>`, which never
    merges (review, 7 Oct 2026: never fixer-merge.py, which merges an unprotected PR itself).
    Only a GREEN dry run whose card refresh succeeded goes back to Kevin: the card then shows the
    new head and his Approve merges it, a real question. Anything else rests (14 Nov 2026): sent
    back, his Approve would merge nothing and the next run would send it back again, for ever."""
    pr = card["pr"]
    why = ("PR #%d changed after this card was raised (it tested %s, the PR is now at %s), so nothing was "
           "merged." % (pr, card["head"][:12], (head or "?")[:12]))
    if not head:
        return moved_wait(card, attempts, head, why + " The new head could not be read.")
    r = run_merge_pr(pr, head, dry_run=True)
    try:
        res = json.loads(r.stdout or "{}")
    except ValueError:
        res = {}
    if r.returncode == 0 and res.get("head", "").startswith(head):
        try:
            refresh_card(card, head, res)
        except Exception as e:  # noqa: BLE001 — said on the card; the old head stays, so it cannot merge
            return moved_wait(card, attempts, head,
                              why + " Re-tested green, but the card could not be refreshed: %s" % str(e)[:160])
        return fail(card, attempts, "error", why + " Re-tested green on the new code; the card now shows it.")
    return moved_wait(card, attempts, head, why + " The new code was re-tested and is not green: %s" % last_lines(
        (r.stderr or "") + "\nwhy: " + str(res.get("why") or ""), 5).replace("\n", " | ")[:300])


def moved_wait(card, attempts, head, why):
    """A moved head that is not a green, refreshed card: never sent back. Counted per NEW head on
    the red clock (RED_RETRY_HOURS apart, at most RED_MAX), then ONE stop finding, then rest until
    the head changes again. moved_rest() in plan() reads what this records."""
    pr = card["pr"]
    why = why.rstrip() if why.rstrip().endswith((".", ")")) else why.rstrip() + "."
    prev = attempts.get(str(pr)) or {}
    same = prev.get("result") == MOVED_RESULT and (prev.get("newHead") or "") == (head or "")
    tries = (_count(prev, "movedTries") if same else 0) + 1
    at = clock()
    entry = {"result": MOVED_RESULT, "approvedAt": card["approvedAt"], "at": now_iso(at), "back": False,
             "head": card["head"], "newHead": head or "", "movedTries": tries, "lastMovedAt": now_iso(at)}
    out = {"pr": pr, "task": card["id"], "result": MOVED_RESULT}
    if tries >= RED_MAX:
        filed = prev.get("finding") if same and prev.get("finding") else stop_finding(
            dict(card, head=head or "?"), tries, why, moved=True)
        entry["finding"] = filed
        out["stopped"] = True
        why += (" The new code has now been re-tested %d times without a green card, so the robot has stopped (%s). "
                "The card rests out of Kevin's queue until the PR's head changes again."
                % (tries, filed or "finding not filed; the next run files it"))
    else:
        out["retryAt"] = now_iso(at + RED_RETRY_HOURS * 3600)
        why += (" Kevin's approval was of the old code, so the card is not sent back for an Approve that would "
                "merge nothing: the robot re-tests the new code by itself after %s (try %d of %d on this code)."
                % (out["retryAt"], tries, RED_MAX))
    out["why"] = why[:700]
    attempts[str(pr)] = entry
    save_attempts(attempts)
    try:
        annotate(card["id"], "MERGE NOT DONE: %s The PR is left open." % why)
    except Exception as e:  # noqa: BLE001 — the result still says what happened
        out["annotateError"] = str(e)[:200]
        print("WARNING: %s" % e, file=sys.stderr)
    return out


def reopen_pending(pr):
    """Findings left `pending --pr PR` when PR closed unmerged would never land (only a merge lands
    them) and the fixer never takes a pending one, so they go back to open with findings.py's own
    `reopen --force`. Returns (ids reopened, problem words or "")."""
    r = py("findings.py", "list", "--status", "pending", "--json")
    if r.returncode != 0:
        return [], "the pending findings could not be read: %s" % (r.stderr or r.stdout or "").strip()[-160:]
    try:
        rows = json.loads(r.stdout or "[]")
    except ValueError:
        return [], "the pending findings list was not JSON"
    done, bad = [], []
    for fid in sorted(x.get("id") for x in rows if isinstance(x, dict) and x.get("id")
                      and str(x.get("pr", "")) == str(pr)):
        rr = py("findings.py", "reopen", fid, "--force", "--note",
                "PR #%d was closed on GitHub without merging, so this fix never landed; back in the queue." % pr)
        (done if rr.returncode == 0 else bad).append(fid)
    return done, ("not reopened: %s" % ", ".join(bad)) if bad else ""


def close_unmerged(card, attempts):
    """An open card whose PR GitHub reports CLOSED without merging (14 Nov 2026), whatever the verdict."""
    pr, task = card["pr"], card["id"]
    lock = Lock("pr-%d.lock" % pr)
    if not lock.held:
        return {"pr": pr, "task": task, "result": "busy", "why": "another run is working on this PR"}
    try:
        return _close_unmerged_locked(card, attempts)
    except Exception as e:  # noqa: BLE001 — said in the run's output; the next run tries again
        return {"pr": pr, "task": task, "result": "error", "why": "%s: %s" % (type(e).__name__, str(e)[:200])}
    finally:
        lock.release()


def _close_unmerged_locked(card, attempts):
    """Re-read GitHub, put the PR's pending findings back, close the card with its own fields (no
    verdict, no merge evidence: `complete` refuses a MERGE card without them, and neither is true),
    record it once, then say so on the card in plain words."""
    pr, task = card["pr"], card["id"]
    state, _, head = pr_state(pr)
    if state != "CLOSED":
        return {"pr": pr, "task": task, "result": "skip", "why": "GitHub no longer says closed (%s)" % state}
    reopened, problem = reopen_pending(pr)
    merge_card.patch_card(task, {merge_card.F["status"]: "Completed", merge_card.F["completionDate"]: now_iso()})
    attempts[str(pr)] = {"result": CLOSED_RESULT, "head": head, "approvedAt": card["approvedAt"], "at": now_iso(),
                         "reopened": reopened}
    save_attempts(attempts)
    words = ("Its pending finding(s) went back to the fixer's queue: %s." % ", ".join(reopened) if reopened
             else "No finding was left pending on it.")
    out = {"pr": pr, "task": task, "result": CLOSED_RESULT, "reopened": reopened}
    if problem:
        words += " Findings %s." % problem
        out["findingsProblem"] = problem
    try:
        annotate(task, "PR CLOSED, NOT MERGED: PR #%d was closed on GitHub without merging, so nothing was merged. "
                       "The robot closed this card; there is nothing to approve. %s" % (pr, words))
    except Exception as e:  # noqa: BLE001 — closed and recorded; the run's output says the note failed
        out["annotateError"] = str(e)[:200]
        print("WARNING: %s" % e, file=sys.stderr)
    return out


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
        attach_live(cards)
        done, failed = [], 0
        for card in sorted(cards, key=lambda c: c["pr"]):
            action, why = plan(card, attempts)
            if args.dry_run or action == "skip":
                done.append({"pr": card["pr"], "task": card["id"], "action": action, "why": why,
                             **({"prReadError": card["prReadError"]} if card.get("prReadError") else {})})
                continue
            if action in ("close-merged", "close-unmerged", "file-finding"):
                res = {"close-merged": close_merged, "close-unmerged": close_unmerged,
                       "file-finding": file_stop}[action](card, attempts)
                failed += res["result"] == "error"
                done.append(dict(res, action=action))
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
            failed += res["result"] in ("red", "error", "merged-open", MOVED_RESULT)
            done.append(dict(res, action="merge"))
        print(json.dumps({"cards": len(cards), "done": done, "dryRun": bool(args.dry_run)}, indent=1))
        return 1 if failed else 0
    finally:
        run_lock.release()


# ─── A PID IS NOT AN IDENTITY ────────────────────────────────────────
#
# 29 Oct 2026, finding 20261029-phase-2-1121. `queued.pid` held 60933, written
# at 00:30 on 19 Oct when that run was queued behind the night render. The run
# died. macOS then recycled the number onto /usr/libexec/trustd, which is alive
# and always will be, so `os.kill(pid, 0)` succeeded, `queued_alive()` reported
# a live holder, and `cmd_detach` printed {"busy": true} and started NOTHING on
# every half-hourly poll for ten days. merge-approved merged nothing in that
# time and said so to nobody: Kevin approved the MERGE card for PR #845 at
# 09:33 on 28 Oct and it never reached a gate. The whole protected-path drain
# ran through a number the OS had given away.
#
# `os.kill(pid, 0)` answers "does some process hold this number", which is not
# the question. The question is "is MY process still running", and the answer
# needs something the OS cannot hand to a stranger: the start time it records
# for that pid. A recycled pid carries a different one by construction, because
# the new process started after the old one exited.
#
# WHICH WAY TO FAIL. A holder this code cannot verify reads as NOT HOLDING, so
# a poll starts a run rather than skipping one. That is the safe direction here
# and it is not the only guard: `run.lock` and the `job-queue.py` lease are
# what actually stop two merges overlapping, and `cmd_detach` probes the lock
# in the same breath. The pid file only decides whether to bother starting.
# A file with no identity recorded in it (every file the old code wrote, and
# any write where `ps` would not answer) is respected for one queue lease and
# treated as debris after that, so neither direction can jam for ever.
# The real Popen, held from import time. `_proc_started` asks the OS a question
# and must not travel through the same seam a caller or a test replaces to
# launch (or to pretend to launch) a queued run.
_POPEN = subprocess.Popen


def _proc_started(pid):
    """What the OS says about WHEN process `pid` started, or None when there is
    no such process or it will not say. Compared as the opaque string `ps`
    prints, never parsed: it is an identity token, not a date."""
    try:
        proc = _POPEN(["ps", "-p", str(int(pid)), "-o", "lstart="],
                      stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        out, _ = proc.communicate(timeout=20)
    except (OSError, ValueError, subprocess.SubprocessError):
        return None
    started = (out or b"").decode("utf-8", "replace").strip()
    return started or None


def queued_alive():
    """The pid of a queued or running merge-approved job, or None.

    Proven by the process's own start time, never by the bare number: see the
    note above. Returns None for a pid the OS has recycled onto something else.
    """
    path = os.path.join(STATE_DIR, QUEUED_PID)
    try:
        with open(path) as fh:
            recorded = fh.read().strip()
    except OSError:
        return None
    parts = recorded.split(None, 1)
    if not parts:
        return None
    try:
        pid = int(parts[0])
    except ValueError:
        return None
    started = parts[1].strip() if len(parts) > 1 else ""
    if not started:
        # No identity to check it against. Trust it for one lease, then treat
        # it as debris: this is the shape the file had for ten days.
        try:
            age_min = (time.time() - os.path.getmtime(path)) / 60.0
        except OSError:
            return None
        if age_min > QUEUE_LEASE_MIN:
            return None
        try:
            os.kill(pid, 0)
        except OSError:
            return None
        return pid
    if _proc_started(pid) != started:
        return None
    return pid


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
    attach_live(cards)
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
        # The pid AND the identity it will be checked against (see the note on
        # queued_alive): a bare number is what a recycled pid walked through.
        fh.write("%s %s" % (p.pid, _proc_started(p.pid) or ""))
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
