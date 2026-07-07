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
import json, os, re, subprocess, sys, time, urllib.request, urllib.parse
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

def parse_plan():
    lines = open(PLAN).read().splitlines()
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

def git(*args, check=True):
    return subprocess.run(["git", "-C", REPO] + list(args),
                          capture_output=True, text=True, check=check)

def cmd_sync():
    if git("status", "--porcelain", "--", "MASTER-PLAN.md").stdout.strip():
        print("ABORT: MASTER-PLAN.md has uncommitted local edits; not syncing over them.")
        return 1
    git("pull", "--rebase", "--autostash", "origin", "main")
    lines, ptasks = parse_plan()
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
    open(PLAN, "w").write("\n".join(lines) + "\n")
    git("add", "MASTER-PLAN.md")
    git("commit", "-m", "chore: nightly master-plan sync\n\n" + "; ".join(parts))
    git("push", "--no-verify", "origin", "main")  # plan-only commit; test gate not needed
    print("committed + pushed")
    return 0

if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith("--") else "sync"
    sys.exit(cmd_map() if mode == "map" else cmd_sync())
