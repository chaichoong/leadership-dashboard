#!/usr/bin/env python3
"""Nightly MASTER-PLAN.md <-> Airtable sync.

MASTER-PLAN.md (repo root) is canonical; Airtable project "Launch & First
Revenue" is the team's working copy. This script keeps them aligned:

  map   one-time: fuzzy-match plan lines to Airtable tasks and stamp
        [AT:recXXX] refs into the plan (high-confidence only; report the rest)
  sync  nightly: tick plan lines whose Airtable task completed; create
        Airtable tasks for ref-less open plan lines (then stamp the ref back);
        report duplicates and drift; append a changelog row; commit + push

Usage: python3 scripts/sync-master-plan.py [map|sync] [--dry-run]
Requires: ~/.config/od/airtable_pat. Log: ~/Library/Logs/od-masterplan-sync.log
"""
import json, os, re, shutil, subprocess, sys, tempfile, time, urllib.request, urllib.parse
from datetime import date
from difflib import SequenceMatcher

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PLAN = os.path.join(REPO, "MASTER-PLAN.md")
BASE = "https://api.airtable.com/v0/appnqjDpqDniH3IRl/tblqB8b22hKBL4PF1"
PROJECT = "recxiy4IAkGb5YkUW"
OWNERS = {"KEVIN": "kevin@runpreneur.org.uk", "MICA": "micaa.work@gmail.com",
          "ERICAMAE": "atentaerica@gmail.com", "OPUS": "kevin@runpreneur.org.uk"}
MONTHS = {m: i + 1 for i, m in enumerate(
    ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"])}
DRY = "--dry-run" in sys.argv
MAX_CREATES = 10

def pat():
    return open(os.path.expanduser("~/.config/od/airtable_pat")).read().strip()

def call(method, url, payload=None):
    req = urllib.request.Request(url, method=method,
        headers={"Authorization": "Bearer " + pat(), "Content-Type": "application/json"},
        data=json.dumps(payload).encode() if payload else None)
    for _ in range(4):
        try:
            return json.load(urllib.request.urlopen(req))
        except urllib.error.HTTPError as e:
            if e.code == 429:
                time.sleep(31); continue
            raise
    raise RuntimeError("rate-limited after retries")

def fetch_tasks():
    records, offset = [], None
    # ARRAYJOIN on a linked field yields display NAMES, not record ids
    formula = "FIND('Launch & First Revenue', ARRAYJOIN({Projects}))"
    while True:
        params = {"pageSize": "100", "filterByFormula": formula}
        if offset:
            params["offset"] = offset
        data = call("GET", BASE + "?" + urllib.parse.urlencode(params))
        records += data.get("records", [])
        offset = data.get("offset")
        if not offset:
            break
        time.sleep(0.25)
    return records

TASK_RE = re.compile(r"^- \[( |x|~|D)\] ([A-Z+]+(?:\+[A-Z]+)?) — (.*)$")
AT_RE = re.compile(r"\[AT:([^\]]*)\]")  # [AT:-] = deliberate no-Airtable-task marker
DUE_RE = re.compile(r"due (\d{1,2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)")

def norm(s):
    s = re.sub(r"\[AT:[^\]]+\]", "", s)
    s = re.sub(r"\((done when:|done |due |NEW)[^)]*\)", "", s)
    s = re.sub(r"[^a-z0-9 ]", " ", s.lower())
    return " ".join(s.split())

STOP = {"the", "a", "an", "to", "of", "for", "and", "or", "on", "in", "with", "per", "into", "from", "every", "all"}

def score(a, b):
    ta = {w for w in a.split() if w not in STOP}
    tb = {w for w in b.split() if w not in STOP}
    tok = len(ta & tb) / min(len(ta), len(tb)) if ta and tb else 0.0
    return max(SequenceMatcher(None, a, b).ratio(), tok)

def parse_plan(plan_path=None):
    lines = open(plan_path or PLAN).read().splitlines()
    tasks = []
    for i, l in enumerate(lines):
        m = TASK_RE.match(l)
        if m:
            refs = []
            am = AT_RE.search(l)
            if am:
                refs = re.findall(r"rec\w+", am.group(1))
            dm = DUE_RE.search(l)
            due = f"2026-{MONTHS[dm.group(2)]:02d}-{int(dm.group(1)):02d}" if dm else None
            tasks.append({"i": i, "state": m.group(1), "lane": m.group(2),
                          "body": m.group(3), "refs": refs, "due": due})
    return lines, tasks

def cmd_map():
    lines, ptasks = parse_plan()
    at = fetch_tasks()
    at_by_norm = [(norm(r["fields"].get("Task Name", "")), r) for r in at]
    stamped, unmatched, used = 0, [], set()
    for t in ptasks:
        if t["refs"] or t["state"] in "xD":
            for r in t["refs"]:
                used.add(r)
            continue
        best, best_sc = None, 0.0
        for n, r in at_by_norm:
            if r["id"] in used:
                continue
            s = score(norm(t["body"]), n)
            if s > best_sc:
                best, best_sc = r, s
        if best and best_sc >= 0.60:
            lines[t["i"]] = lines[t["i"]].replace(t["body"],
                t["body"] + f" [AT:{best['id']}]", 1)
            used.add(best["id"]); stamped += 1
            print(f"  MAP {best_sc:.2f} {t['body'][:60]} -> {best['fields'].get('Task Name','')[:60]}")
        else:
            unmatched.append(t["body"][:80])
    if not DRY:
        open(PLAN, "w").write("\n".join(lines) + "\n")
    print(f"map: stamped {stamped}, unmatched {len(unmatched)}")
    for u in unmatched:
        print("  UNMATCHED:", u)

def append_changelog(lines, summary):
    today = date.today().isoformat()
    row = f"| {today} | Nightly sync (scripts/sync-master-plan.py) | {summary} |"
    for i in range(len(lines) - 1, -1, -1):
        if lines[i].startswith("|") and "|" in lines[i][1:]:
            lines.insert(i + 1, row)
            return
    lines.append(row)

def git(*args, check=True, cwd=None):
    return subprocess.run(["git", "-C", cwd or REPO] + list(args),
                          capture_output=True, text=True, check=check)


class PlanWorktree:
    """A private, disposable checkout of origin/main to do the commit in.

    This job used to run `git pull --rebase --autostash origin main` straight in
    the shared checkout. Three things went wrong with that, and the third broke
    it every night from 4 Aug 2026:

      1. --autostash stashes and reapplies work belonging to whatever Claude
         session happens to be mid-task. That is the 16 Jul 2026 incident.
      2. It moves HEAD in a checkout somebody else is using.
      3. It ABORTS outright when the checkout holds untracked files that also
         exist upstream, which is exactly the state a squash-merged PR leaves
         behind. `error: The following untracked working tree files would be
         overwritten by checkout: scripts/mac-guard.sh ...`

    A detached worktree at origin/main has none of those problems: it is ours,
    it is clean by construction, and it is deleted afterwards.
    """

    def __init__(self):
        self.path = None

    @staticmethod
    def prune_stale():
        """Clear out worktrees a KILLED earlier run could not clean up.

        __exit__ never runs when the process is killed (the Mac sleeping mid-run
        is the usual cause), so its own tidy-up cannot be relied on. Every
        abandoned worktree then stays registered for ever, and `git worktree
        list` fills with dead masterplan-sync-* entries that make a genuinely
        stuck run impossible to spot.

        Doing it at the START is what makes it work: it runs on the NEXT run
        rather than depending on this one surviving. Cheap and idempotent —
        `prune` only removes admin entries whose directory is already gone, and
        the explicit remove only touches paths this class created.
        """
        git("worktree", "prune", check=False)
        listing = git("worktree", "list", "--porcelain", check=False).stdout or ""
        for line in listing.splitlines():
            if not line.startswith("worktree "):
                continue
            path = line[len("worktree "):].strip()
            # Only ever our own temp checkouts. Never a real workspace.
            if os.path.basename(path).startswith("masterplan-sync-"):
                git("worktree", "remove", "--force", path, check=False)
                shutil.rmtree(path, ignore_errors=True)
        git("worktree", "prune", check=False)

    def __enter__(self):
        self.prune_stale()
        git("fetch", "origin", "main")
        self.path = tempfile.mkdtemp(prefix="masterplan-sync-")
        # Remove first: mkdtemp already made the directory and `worktree add`
        # insists on creating it itself.
        os.rmdir(self.path)
        git("worktree", "add", "--detach", self.path, "origin/main")
        return self.path

    def __exit__(self, *exc):
        if not self.path:
            return False
        # --force because we may have left a commit here; prune tidies the
        # admin files either way, so a failure never accumulates worktrees.
        git("worktree", "remove", "--force", self.path, check=False)
        git("worktree", "prune", check=False)
        shutil.rmtree(self.path, ignore_errors=True)
        return False

def cmd_sync():
    # Still worth checking the shared checkout: if a human is mid-edit on the
    # plan, syncing origin/main over the top would strand their work.
    if git("status", "--porcelain", "--", "MASTER-PLAN.md").stdout.strip():
        print("ABORT: MASTER-PLAN.md has uncommitted local edits; not syncing over them.")
        return 1
    with PlanWorktree() as wt:
        return _sync_in(wt)


def _sync_in(wt):
    plan_path = os.path.join(wt, "MASTER-PLAN.md")
    lines, ptasks = parse_plan(plan_path)
    at = fetch_tasks()
    by_id = {r["id"]: r for r in at}
    ticked, created, flags = [], [], []

    # duplicates among open Airtable tasks
    open_names = [norm(r["fields"].get("Task Name", "")) for r in at
                  if r["fields"].get("Status") != "Completed"]
    dupes = {n for n in open_names if open_names.count(n) > 1}
    if dupes:
        flags.append(f"duplicate open task names in Airtable: {sorted(dupes)}")

    for t in ptasks:
        if t["state"] == " " and t["refs"]:
            recs = [by_id.get(r) for r in t["refs"] if by_id.get(r)]
            if recs and all(r["fields"].get("Status") == "Completed" for r in recs):
                lines[t["i"]] = lines[t["i"]].replace("- [ ]", "- [x]", 1) \
                    + f" *(ticked {date.today().isoformat()}, synced from Airtable)*"
                ticked.append(t["body"][:70])
        elif t["state"] == "x" and t["refs"]:
            for r in t["refs"]:
                rec = by_id.get(r)
                if rec and rec["fields"].get("Status") not in ("Completed", None):
                    flags.append(f"plan says done, Airtable open: {rec['fields'].get('Task Name','')[:60]} ({r})")

    # create Airtable tasks for open, ref-less plan lines (guarded)
    creatable = [t for t in ptasks if t["state"] == " " and not AT_RE.search(lines[t["i"]])
                 and t["due"] and t["lane"].split("+")[0] in OWNERS]
    for t in creatable[:MAX_CREATES]:
        name = re.sub(r"\((done when:)[^)]*\)", "", t["body"])
        name = re.sub(r"\[AT:[^\]]+\]", "", name).strip().rstrip(".")[:120]
        if any(score(norm(name), norm(r["fields"].get("Task Name", ""))) > 0.55
               for r in at if r["fields"].get("Status") != "Completed"):
            flags.append(f"skipped create (similar open task exists): {name[:60]}")
            continue
        if DRY:
            created.append((None, t, name)); continue
        res = call("POST", BASE, {"records": [{"fields": {
            "Task Name": name, "Assignee": {"email": OWNERS[t["lane"].split("+")[0]]}}}]})
        rid = res["records"][0]["id"]
        time.sleep(40)  # defaults automation
        call("PATCH", f"{BASE}/{rid}", {"fields": {"Due Date": t["due"],
            "Projects": [PROJECT],
            "Description": f"Created by the nightly plan sync. Source: MASTER-PLAN.md. {t['body'][:400]}"}})
        lines[t["i"]] = lines[t["i"]].replace(t["body"], t["body"] + f" [AT:{rid}]", 1)
        created.append((rid, t, name))
    if len(creatable) > MAX_CREATES:
        flags.append(f"{len(creatable) - MAX_CREATES} creatable lines deferred (per-run cap {MAX_CREATES})")

    changed = bool(ticked or created)
    print(f"sync: ticked {len(ticked)}, created {len(created)}, flags {len(flags)}")
    for x in ticked: print("  TICKED:", x)
    for _, _, n in created: print("  CREATED:", n)
    for f in flags: print("  FLAG:", f)
    if DRY or not changed:
        if flags and not DRY:
            print("no plan changes; flags above are informational")
        return 0
    parts = []
    if ticked: parts.append(f"ticked {len(ticked)} from Airtable completions")
    if created: parts.append(f"pushed {len(created)} new plan tasks to Airtable")
    append_changelog(lines, "; ".join(parts) + ".")
    open(plan_path, "w").write("\n".join(lines) + "\n")
    git("add", "MASTER-PLAN.md", cwd=wt)
    git("commit", "-m", "chore: nightly master-plan sync\n\n" + "; ".join(parts), cwd=wt)
    # HEAD is detached at origin/main in here, so name both ends of the push.
    git("push", "--no-verify", "origin", "HEAD:main", cwd=wt)
    print("committed + pushed")
    return 0

if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith("--") else "sync"
    sys.exit(cmd_map() if mode == "map" else cmd_sync())
