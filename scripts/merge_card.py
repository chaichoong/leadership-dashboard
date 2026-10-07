#!/usr/bin/env python3
"""The MERGE card: a protected-path fix from the queue fixer reaches Kevin as one approval card.

WHY (Kevin, 7 Oct 2026, the blocked-task audit). 19 tasks sat on TOOL walls whose fixes needed
a protected file (scripts/agent-dispatch.py, the runners, agent-settings.json...). The fixer may
write those fixes but fixer-merge.py never merges them, so the fixer deferred them "for Kevin"
and nothing told him: none of the 18 findings behind those walls was ever claimed, and the row
said "waiting on the daily robot fix" for twelve days. A wall with no door.

So a protected fix now ends as a card, never a dead end:
  1. fixer-merge.py leaves the PR open, runs the full gate on the merge result, and on green
     raises ONE card per PR here: "MERGE: PR #N — <title>", Status Approval, sent for approval
     by the Builder agent, with the PR link, the findings it closes, the files and the result.
  2. Kevin approves it in his queue like any other card.
  3. scripts/merge-approved.py (no model, every 30 minutes) runs merge-pr.py on it, completes the
     card with the merge commit, and lands the findings, which wakes every TOOL wall on them.

This module owns the card's shape, so the writer (fixer-merge.py), the merger (merge-approved.py)
and the readers (agent-dispatch.py's queue and blocker sweep) can never disagree about it.
"""

import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
BASE_ID = "appnqjDpqDniH3IRl"
TASKS = "tblqB8b22hKBL4PF1"

# Field ids, the same names as js/config.js TASK_FIELDS (drift-tested in
# tests/merge-card.test.js).
F = {
    "name":             "fldgFjGBw6bTKJFCD",
    "status":           "fldx4qCw17UfrKpaN",
    "description":      "fldRGhBQViKZKtkQ6",
    "notes":            "fldR7apBzSp3oxFxz",
    "dueDate":          "fld7XP8w8kbxfETV4",
    "teamMember":       "flduCtmQGpOA4eWaj",
    "sentForApprovalBy": "fld30Yw8SWYVp049g",
    "approvalOutcome":  "fldrHBSr6qoUfaKuZ",
    "approvedAt":       "fldr4Mvf2RzKvhZhi",
    "taskType":         "fldZ2moDV2041Sobc",
    "agentOutput":      "fldzswp8fx6PqpLQ5",
    "approvalFeedback": "fldtI7SJI4gEohHD1",
    "completionDate":   "fldFOi1SwEKuJRmdN",
}
PLAIN_SUMMARY = "fld3PrM8AJcnWHemG"   # agent-dispatch.py AF["plainSummary"]

# The AI Worker: Builder (agent-dispatch.py AGENTS, "worker-builder"). It writes code, so
# it is the agent a code merge is sent for approval by.
BUILDER_TM = "recQkO6BA4w5zqwZ4"

MERGE_PREFIX = "MERGE: PR #"
NAME_RE = re.compile(r"^MERGE: PR #(\d+)(?=\s|$)")
APPROVE_LINE = "If you approve, the robot runs merge-pr.py and the deploy, nothing else."
FINDINGS_HEAD = "Findings it closes:"
FINDING_ID_RE = re.compile(r"\b(\d{8}-[A-Za-z0-9-]+-\d{3,})\b")
APPROVED = ("Approved as-is", "Approved with minor edits")
REPO_URL = "https://github.com/chaichoong/leadership-dashboard"
# The PR head the gate tested, written on the card. Kevin's approval is of THAT head: a push
# after the card was raised must never merge on his "yes" (review, 7 Oct 2026).
HEAD_LINE = "Tested head: "
HEAD_RE = re.compile(r"^Tested head: ([0-9a-f]{40})$", re.M)


_PROTECTED = None
# File names several protected or unprotected files share, so a bare mention names none of them.
AMBIGUOUS_NAMES = ("index.html", "config.js")


def protected_paths():
    """fixer-merge.py's PROTECTED list, read from that file so the two can never disagree.
    An unreadable file raises: a wrong "no protected file" would be a quiet lie on Kevin's row."""
    global _PROTECTED
    if _PROTECTED is None:
        import importlib.util
        spec = importlib.util.spec_from_file_location("fixer_merge_for_cards", os.path.join(HERE, "fixer-merge.py"))
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        _PROTECTED = tuple(mod.PROTECTED)
    return _PROTECTED


def protected_named(text):
    """The first protected path a finding's own words name, or ''. A path in full
    (scripts/agent-dispatch.py), a folder rule (scripts/slack-automation/...) or a bare file
    name that cannot be part of a longer one (agent-dispatch.py, never vitest.config.js)."""
    s = str(text or "")
    for p in protected_paths():
        if p.endswith("/"):
            if p in s:
                return p
            continue
        # A repo path may follow "/" (an absolute path, ./scripts/...), never another word or dot.
        if re.search(r"(?<![\w.-])%s(?![\w-])" % re.escape(p), s):
            return p
        # A bare file name counts only when it is distinctive and stands alone: "agent-dispatch.py",
        # never "index.html" (every page has one) and never the end of another path such as
        # os/tasks/index.html or workers/x/config.js (review, 7 Oct 2026).
        base = os.path.basename(p)
        if base not in AMBIGUOUS_NAMES and re.search(r"(?<![\w./-])%s(?![\w-])" % re.escape(base), s):
            return p
    return ""


def pr_number(name):
    """The PR number a MERGE card names, or None for any other task."""
    m = NAME_RE.match(str(name or ""))
    return int(m.group(1)) if m else None


def is_merge_card(name):
    return pr_number(name) is not None


def card_name(pr, title):
    # The shape Kevin's plan names, 7 Oct 2026. Never `MERGE: PR #N` alone: the existence
    # check matches on "MERGE: PR #N " so #71 can never match #712.
    return ("%s%d — %s" % (MERGE_PREFIX, int(pr), " ".join(str(title or "").split()) or "(no title)"))[:250]


def card_findings(text):
    """The finding ids listed under FINDINGS_HEAD on a card, in order. Only that block counts:
    a test tail quoting another finding id must never tie a wall to the wrong card."""
    out, on = [], False
    for line in str(text or "").splitlines():
        s = line.strip()
        if s == FINDINGS_HEAD:
            on = True
            continue
        if on:
            if not s.startswith("- "):
                break
            m = FINDING_ID_RE.search(s)
            if m and m.group(1) not in out:
                out.append(m.group(1))
    return out


def _last_line(tail):
    lines = [x.strip() for x in str(tail or "").splitlines() if x.strip()]
    return lines[-1][:200] if lines else "no output"


def card_output(pr, title, url, findings, files, protected, gate, head=""):
    """The card's Agent Output. `findings` is [(id, title)], `files` every path the PR touches,
    `protected` the protected ones, `gate` fixer-merge.py's run_gate dict, `head` the PR head
    the gate tested."""
    v = (gate or {}).get("vitest") or {}
    b = (gate or {}).get("browser") or {}
    lines = [
        "MERGE CARD: PR #%d, %s" % (int(pr), " ".join(str(title or "").split()) or "(no title)"),
        url or "%s/pull/%d" % (REPO_URL, int(pr)),
        HEAD_LINE + (head or "not recorded"),
        "",
        "The fixer wrote this fix. It touches a protected file, so it never merges itself.",
        "",
        FINDINGS_HEAD,
    ]
    if findings:
        lines += ["- %s: %s" % (fid, " ".join(str(t or "").split())[:160]) for fid, t in findings]
    else:
        lines.append("- none recorded as pending on this PR (the fixer closed none with --pr %d)" % int(pr))
    lines += ["", "Files touched:"]
    prot = set(protected or [])
    lines += ["- %s%s" % (f, " (protected)" if f in prot else "") for f in (files or [])] or ["- none listed"]
    lines += ["",
              "Test result: GREEN on origin/main with this PR merged in. vitest: %s. Browser suite: %s."
              % (_last_line(v.get("tail")), _last_line(b.get("tail"))),
              "",
              "**Carrying this out will involve:** " + APPROVE_LINE]
    return "\n".join(lines)


def card_fields(pr, title, url, findings, files, protected, gate, today, head=""):
    return {
        F["name"]: card_name(pr, title),
        F["status"]: "Approval",
        F["dueDate"]: today,
        F["teamMember"]: [BUILDER_TM],
        F["sentForApprovalBy"]: [BUILDER_TM],
        F["taskType"]: "Build",
        F["agentOutput"]: card_output(pr, title, url, findings, files, protected, gate, head),
        F["description"]: ("The queue fixer's PR #%d touches a protected file, so the merge is Kevin's call. "
                           "scripts/merge-approved.py merges it once he approves." % int(pr)),
        PLAIN_SUMMARY: ("TASK: Merge the robot's fix in PR #%d (%s).\nIF YOU APPROVE: %s"
                        % (int(pr), " ".join(str(title or "").split())[:120], APPROVE_LINE)),
    }


# ─── Airtable (paginated, one reader) ──────────────────────────────────────

def pat():
    with open(os.path.expanduser("~/.config/od/airtable_pat")) as fh:
        return fh.read().strip()


def _request(method, path, body=None):
    url = "https://api.airtable.com/v0/%s%s" % (BASE_ID, path)
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        "Authorization": "Bearer %s" % pat(), "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as e:
        raise RuntimeError("Airtable %s %s -> HTTP %d: %s"
                           % (method, path.split("?")[0], e.code, e.read().decode("utf-8", "replace")[:300])) from None


def read_tasks(formula, fields=None, max_records=None):
    """Every task matching FORMULA, following offset to the last page."""
    out, offset = [], None
    while True:
        params = [("pageSize", "100"), ("returnFieldsByFieldId", "true"), ("filterByFormula", formula)]
        if max_records:
            params.append(("maxRecords", str(max_records)))
        params += [("fields[]", f) for f in (fields or list(F.values()))]
        if offset:
            params.append(("offset", offset))
        body = _request("GET", "/%s?%s" % (TASKS, urllib.parse.urlencode(params)))
        out += body.get("records", [])
        offset = body.get("offset")
        if not offset:
            return out


def _sel(v):
    return v.get("name", "") if isinstance(v, dict) else (v or "")


def card_view(rec):
    f = rec.get("fields", {}) or {}
    return {"id": rec.get("id", ""), "name": f.get(F["name"], ""), "pr": pr_number(f.get(F["name"], "")),
            "status": _sel(f.get(F["status"])), "outcome": _sel(f.get(F["approvalOutcome"])),
            "approvedAt": f.get(F["approvedAt"], "") or "", "feedback": f.get(F["approvalFeedback"], "") or "",
            "notes": f.get(F["notes"], "") or "", "agentOutput": f.get(F["agentOutput"], "") or "",
            "findings": card_findings(f.get(F["agentOutput"], "")),
            "head": (HEAD_RE.search(f.get(F["agentOutput"], "") or "") or [None, ""])[1],
            # Kept whole for the approval-evidence check (scripts/approval_evidence.py).
            "fields": f, "createdTime": rec.get("createdTime", "")}


def card_body_problem(card):
    """'' when the card is still the card fixer-merge.py raised, else why not. Its name alone
    is not enough: an agent's submit or escalate keeps the name and replaces the body, and
    Kevin's "yes" to a DECIDE: or a CLOSE PROPOSAL must never merge a protected PR (review,
    7 Oct 2026)."""
    out = str(card.get("agentOutput") or "")
    first = next((ln.strip() for ln in out.splitlines() if ln.strip()), "")
    if not first.startswith("MERGE CARD: PR #%s," % card.get("pr")):
        return "its work does not open with the MERGE CARD line for PR #%s" % card.get("pr")
    if APPROVE_LINE not in out:
        return "its work no longer carries the line Kevin approved"
    if not card.get("head"):
        return "it does not record the PR head that was tested"
    sent = [x.get("id") if isinstance(x, dict) else x for x in ((card.get("fields") or {}).get(F["sentForApprovalBy"]) or [])]
    if sent != [BUILDER_TM]:
        return "it was not sent for approval by the Builder"
    return ""


def patch_card(task_id, fields):
    """One write to a card (Status, outcome, plain summary). typecast for the select fields."""
    return _request("PATCH", "/%s/%s" % (TASKS, task_id), {"fields": fields, "typecast": True})


def cards_formula():
    return "LEFT({Task Name}, %d)='%s'" % (len(MERGE_PREFIX), MERGE_PREFIX)


def list_cards(read=None):
    """Every MERGE card, any status. The name prefix is matched again here, so a formula that
    widens can never hand a non-card to the merger."""
    read = read or read_tasks
    return [c for c in (card_view(r) for r in read(cards_formula())) if c["pr"] is not None]


def existing_card(pr, read=None):
    """A card already raised for PR, at ANY status, or None. Any status, because a card Kevin
    rejected must never come back as a second card for the same PR."""
    read = read or read_tasks
    rows = read("FIND('%s%d ', {Task Name})=1" % (MERGE_PREFIX, int(pr)))
    hits = [card_view(r) for r in rows if pr_number((r.get("fields") or {}).get(F["name"])) == int(pr)]
    # An open card first: it is the one to refresh; a closed one only stops a second card.
    hits.sort(key=lambda c: c["status"] == "Completed")
    return hits[0] if hits else None


def create_card(fields, run=None):
    """Create the card through the one task gate. --force: two MERGE cards share every word but
    the number, which the duplicate key deletes, so the gate would fold PR #712 into PR #715. The
    exact-number existence check (existing_card) is this card's duplicate gate instead."""
    run = run or subprocess.run
    r = run([sys.executable, os.path.join(HERE, "create-agent-task.py"), "create", "--force",
             "--fields-json", json.dumps(fields)], capture_output=True, text=True)
    try:
        out = json.loads((r.stdout or "").strip().splitlines()[-1])
    except (ValueError, IndexError):
        out = {}
    if r.returncode != 0 or not str(out.get("taskId", "")).startswith("rec"):
        raise RuntimeError("create-agent-task.py exited %d: %s"
                           % (r.returncode, ((r.stderr or "") + (r.stdout or "")).strip()[-300:]))
    return out["taskId"]
