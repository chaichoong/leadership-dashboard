#!/usr/bin/env python3
"""built_inventory.py — everything built, read from the files that run it.

WHY THIS EXISTS (Kevin, 29 Sep 2026): "something that lists everything we've
built that stays updated in real time, so we have a track record and a kind of
log of everything that we've built." The 29 Sep display audit found no such
list: the automations list and the Skills Library were kept by hand, about 20
automations rows were wrong, five Mac jobs and four GitHub timers were on no
page at all.

So this reads the real sources, never a list someone remembered to edit:
  Mac jobs         ~/Library/LaunchAgents (+ .parked), joined to job-schedule.json
  scheduled tasks  ~/.claude/scheduled-tasks/*/SKILL.md
  agent files      ~/.claude/agents/*.md
  skills           ~/.claude/skills, ~/.claude/skills/anthropic-skills, .claude/skills
  workers          workers/*/wrangler.toml, cloudflare-worker/, scripts/slack-automation/
  GitHub timers    .github/workflows/*.yml
The plain-English "what it does" line comes from js/automations-data.js where
one exists, else from the source's own description. Anything running that the
hand-kept lists do not mention is reported under `missing`, which is how those
lists get retired: once `missing` stays empty they are redundant.

WHERE IT GOES. scripts/estate-status.py calls build() every ten minutes and
writes the result as the Payload of one PRIVATE Estate Status row
(`built-inventory`); the AI Agents page's Track record tab reads it. It is
never written into this repo: the repo is public and the descriptions name
creditors, tenants and legal work.

CONTROLS. Every source has a floor. A wrong path, a moved folder or a launchd
environment that cannot see ~/Library would otherwise return nothing and read
as "the estate shrank". Any source under its floor raises SourceFailure and
the row goes red with the reason, instead of a shorter list.

Usage: python3 scripts/built_inventory.py [--json]
"""

import glob
import json
import os
import plistlib
import re
import sys
from datetime import datetime, timezone

HOME = os.environ.get("BUILT_HOME") or os.path.expanduser("~")
REPO = os.environ.get("BUILT_REPO") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# The Airtable long-text field holds 100,000 characters. Stay clear of it.
PAYLOAD_CAP = 90000
DESC_CHARS = 180

LABEL_PREFIXES = ("com.kevinbrittain.", "com.od.")

# Sources and their floors, 29 Sep 2026 counts in brackets. A floor well under
# the real count catches a broken read, never a normal retirement.
FLOORS = {
    "macJobs": 20,          # (41 loaded)
    "scheduledTasks": 10,   # (27)
    "agentFiles": 10,       # (25)
    "skills": 15,           # (34)
    "workers": 5,           # (13)
    "githubTimers": 1,      # (7 workflows, 4 on a timer)
}


class SourceFailure(RuntimeError):
    pass


def _short(text, n=DESC_CHARS):
    text = " ".join(str(text or "").split())
    return text if len(text) <= n else text[: n - 1].rstrip() + "…"


def _rel(path):
    if path.startswith(REPO + os.sep):
        return os.path.relpath(path, REPO)
    if path.startswith(HOME + os.sep):
        return "~/" + os.path.relpath(path, HOME)
    return path


def _modified(path):
    try:
        return datetime.fromtimestamp(os.path.getmtime(path), timezone.utc).strftime("%Y-%m-%d")
    except OSError:
        return None


def frontmatter(path):
    """name and description from a markdown file's front matter, or {}."""
    try:
        with open(path, encoding="utf-8") as fh:
            text = fh.read(8000)
    except OSError:
        return {}
    m = re.match(r"---\s*\n(.*?)\n---", text, re.S)
    if not m:
        return {}
    out, lines, i = {}, m.group(1).split("\n"), 0
    while i < len(lines):
        km = re.match(r"^([A-Za-z_-]+):\s*(.*)$", lines[i])
        if km:
            key, val = km.group(1), km.group(2).strip()
            if val in (">", "|", ">-", "|-"):
                block = []
                while i + 1 < len(lines) and (lines[i + 1].startswith(" ") or not lines[i + 1].strip()):
                    i += 1
                    block.append(lines[i].strip())
                val = " ".join(b for b in block if b)
            elif len(val) >= 2 and val[0] == val[-1] and val[0] in "\"'":
                val = val[1:-1].replace('\\"', '"').replace("\\'", "'")
            out[key] = val
        i += 1
    return out


def automations_text():
    try:
        with open(os.path.join(REPO, "js", "automations-data.js"), encoding="utf-8") as fh:
            return fh.read()
    except OSError:
        return ""


def automation_entries(src):
    """key -> (name, what) and worker name -> what, from the hand-kept list."""
    jobs, workers = {}, {}
    q = r"'((?:[^'\\]|\\.)*)'"
    # Fields may come in any order after key (agent rows read `key, agent: true, name`).
    for m in re.finditer(r"\{\s*key:\s*" + q + r"(.*?)\}", src, re.S):
        name = re.search(r"\bname:\s*" + q, m.group(2), re.S)
        what = re.search(r"\bwhat:\s*" + q, m.group(2), re.S)
        jobs[m.group(1)] = (name.group(1).replace("\\'", "'") if name else m.group(1),
                            what.group(1).replace("\\'", "'") if what else "")
    for m in re.finditer(r"\{\s*name:\s*" + q + r"(.*?)\}", src, re.S):
        what = re.search(r"what:\s*" + q, m.group(2), re.S)
        workers[m.group(1)] = what.group(1).replace("\\'", "'") if what else ""
    return jobs, workers


def _when(plist):
    if plist.get("KeepAlive") and not plist.get("StartCalendarInterval") and not plist.get("StartInterval"):
        return "always on"
    iv = plist.get("StartInterval")
    if iv:
        return "every %d min" % (iv // 60) if iv < 3600 else "every %g h" % (iv / 3600)
    cal = plist.get("StartCalendarInterval")
    if cal:
        cal = cal if isinstance(cal, list) else [cal]
        times = sorted({"%02d:%02d" % (c.get("Hour", 0), c.get("Minute", 0))
                        for c in cal if "Hour" in c})
        if times:
            return ", ".join(times[:6]) + (" …" if len(times) > 6 else "")
        mins = sorted({c.get("Minute", 0) for c in cal})
        return "hourly at :" + ", :".join("%02d" % m for m in mins[:4])
    if plist.get("RunAtLoad"):
        return "at login"
    return ""


def load_schedule():
    try:
        with open(os.path.join(REPO, "scripts", "job-schedule.json")) as fh:
            return {k: v for k, v in json.load(fh).items() if isinstance(v, dict)}
    except (OSError, ValueError) as exc:
        raise SourceFailure("scripts/job-schedule.json could not be read: %s" % exc)


def mac_jobs(labels, schedule):
    agents = os.path.join(HOME, "Library", "LaunchAgents")
    parked_dir = os.path.join(HOME, "Library", "LaunchAgents.parked")
    found = {}
    for folder, parked in ((agents, False), (parked_dir, True)):
        for path in sorted(glob.glob(os.path.join(folder, "*.plist"))):
            base = os.path.basename(path)
            if ".bak" in base or not base.startswith(LABEL_PREFIXES):
                continue
            try:
                with open(path, "rb") as fh:
                    pl = plistlib.load(fh)
            except Exception as exc:  # noqa: BLE001 — an unreadable plist is shown, not skipped
                pl = {"_error": str(exc)[:120]}
            label = pl.get("Label") or base[:-6]
            key = label
            for p in LABEL_PREFIXES:
                if key.startswith(p):
                    key = key[len(p):]
            if key in found:
                continue
            cfg = schedule.get(key, {})
            if parked:
                status = "parked"
            elif cfg.get("enabled") is False:
                status = "off"
            else:
                status = "on"
            name, what = labels.get(key, (key, ""))
            found[key] = {"k": key, "n": name, "w": _when(pl), "s": status,
                          "d": _short(what), "src": _rel(path), "m": _modified(path)}
    live = [j for j in found.values() if j["s"] != "parked"]
    if len(live) < FLOORS["macJobs"]:
        raise SourceFailure("read %d Mac jobs in %s (expected %d+): the folder is not readable from here, "
                            "not an empty estate" % (len(live), _rel(agents), FLOORS["macJobs"]))
    # Scheduled by something other than launchd (daily-ops: the Claude scheduler).
    for key, cfg in schedule.items():
        if key.startswith("_") or key in found or not cfg.get("cron"):
            continue
        if cfg.get("enabled") is False:
            continue
        name, what = labels.get(key, (key, ""))
        found[key] = {"k": key, "n": name, "w": cfg["cron"], "s": "on", "d": _short(what),
                      "src": "scripts/job-schedule.json", "m": None, "via": "Claude scheduler"}
    return sorted(found.values(), key=lambda j: (j["s"] != "on", j["n"].lower()))


def scheduled_tasks(schedule):
    rows = []
    for path in sorted(glob.glob(os.path.join(HOME, ".claude", "scheduled-tasks", "*", "SKILL.md"))):
        fm = frontmatter(path)
        slug = os.path.basename(os.path.dirname(path))
        desc = fm.get("description", "")
        head = re.match(r"\s*(RETIRED|ABSORBED|PAUSED|PARKED)\b", desc)
        if head:
            status = {"RETIRED": "retired", "ABSORBED": "inside daily-ops"}.get(head.group(1), "paused")
        elif schedule.get(slug, {}).get("enabled") is False:
            status = "off"
        else:
            status = "on"
        rows.append({"k": slug, "n": fm.get("name") or slug, "s": status,
                     "d": _short(desc), "src": _rel(path), "m": _modified(path)})
    if len(rows) < FLOORS["scheduledTasks"]:
        raise SourceFailure("read %d scheduled-task folders (expected %d+)" % (len(rows), FLOORS["scheduledTasks"]))
    order = {"on": 0, "inside daily-ops": 1, "off": 2, "paused": 3, "retired": 4}
    return sorted(rows, key=lambda r: (order.get(r["s"], 9), r["n"].lower()))


def agent_files():
    rows = []
    for path in sorted(glob.glob(os.path.join(HOME, ".claude", "agents", "*.md"))):
        fm = frontmatter(path)
        slug = os.path.basename(path)[:-3]
        rows.append({"k": slug, "n": fm.get("name") or slug, "s": "live" if fm else "reference",
                     "d": _short(fm.get("description", "")), "src": _rel(path), "m": _modified(path)})
    if len(rows) < FLOORS["agentFiles"]:
        raise SourceFailure("read %d agent files (expected %d+)" % (len(rows), FLOORS["agentFiles"]))
    return rows


def skills():
    rows = []
    places = ((os.path.join(HOME, ".claude", "skills", "*", "SKILL.md"), "global"),
              (os.path.join(HOME, ".claude", "skills", "anthropic-skills", "*", "SKILL.md"), "global"),
              (os.path.join(REPO, ".claude", "skills", "*", "SKILL.md"), "project"))
    for pattern, where in places:
        for path in sorted(glob.glob(pattern)):
            fm = frontmatter(path)
            slug = os.path.basename(os.path.dirname(path))
            rows.append({"k": slug, "n": fm.get("name") or slug, "s": where, "d": _short(fm.get("description", "")),
                         "src": _rel(path), "m": _modified(path)})
    if len(rows) < FLOORS["skills"]:
        raise SourceFailure("read %d skills (expected %d+)" % (len(rows), FLOORS["skills"]))
    return sorted(rows, key=lambda r: r["n"].lower())


def _toml_top(text, key):
    for line in text.splitlines():
        if line.startswith("["):
            return None
        m = re.match(r"^%s\s*=\s*\"([^\"]*)\"" % key, line)
        if m:
            return m.group(1)
    return None


def workers(worker_whats):
    paths = (sorted(glob.glob(os.path.join(REPO, "workers", "*", "wrangler.toml")))
             + sorted(glob.glob(os.path.join(REPO, "cloudflare-worker", "wrangler*.toml")))
             + sorted(glob.glob(os.path.join(REPO, "scripts", "slack-automation", "wrangler*.toml"))))
    rows = []
    for path in paths:
        with open(path, encoding="utf-8") as fh:
            text = fh.read()
        name = _toml_top(text, "name")
        if not name:
            continue
        cm = re.search(r"^crons\s*=\s*\[(.*?)\]", text, re.M | re.S)
        crons = re.findall(r"\"([^\"]+)\"", cm.group(1)) if cm else []
        when = ", ".join(crons) + " (UTC)" if crons else ("timer removed" if cm else "on request")
        rows.append({"k": name, "n": name, "w": when, "s": "off" if (cm and not crons) else "on",
                     "d": _short(worker_whats.get(name, "")), "src": _rel(path), "m": _modified(path)})
    if len(rows) < FLOORS["workers"]:
        raise SourceFailure("read %d workers (expected %d+)" % (len(rows), FLOORS["workers"]))
    return sorted(rows, key=lambda r: r["n"].lower())


def github_timers():
    rows = []
    for path in sorted(glob.glob(os.path.join(REPO, ".github", "workflows", "*.y*ml"))):
        with open(path, encoding="utf-8") as fh:
            text = fh.read()
        nm = re.search(r"^name:\s*(.+)$", text, re.M)
        crons = re.findall(r"cron:\s*['\"]([^'\"]+)['\"]", text)
        rows.append({"k": os.path.basename(path), "n": (nm.group(1).strip().strip("'\"") if nm else os.path.basename(path)),
                     "w": ", ".join(crons) + " (UTC)" if crons else "on push or by hand",
                     "s": "timer" if crons else "on push", "d": "", "src": _rel(path), "m": _modified(path)})
    if sum(1 for r in rows if r["s"] == "timer") < FLOORS["githubTimers"]:
        raise SourceFailure("found no scheduled GitHub workflow (expected %d+)" % FLOORS["githubTimers"])
    return rows


def build(now=None):
    now = now or datetime.now(timezone.utc)
    src = automations_text()
    labels, worker_whats = automation_entries(src)
    try:
        with open(os.path.join(REPO, "js", "skills-data.js"), encoding="utf-8") as fh:
            skills_src = fh.read()
    except OSError:
        skills_src = ""
    schedule = load_schedule()
    groups = [
        {"id": "mac-jobs", "title": "Scheduled jobs on the Mac", "items": mac_jobs(labels, schedule)},
        {"id": "agent-files", "title": "AI agent files", "items": agent_files()},
        {"id": "skills", "title": "Skills", "items": skills()},
        {"id": "workers", "title": "Cloudflare workers", "items": workers(worker_whats)},
        {"id": "github-timers", "title": "GitHub workflows", "items": github_timers()},
        {"id": "scheduled-tasks", "title": "Scheduled-task instructions", "items": scheduled_tasks(schedule)},
    ]
    by = {g["id"]: g["items"] for g in groups}
    missing = {
        "automations": sorted(j["k"] for j in by["mac-jobs"] if j["s"] == "on" and j["k"] not in labels),
        "workers": sorted(w["k"] for w in by["workers"] if w["k"] not in worker_whats),
        "skills": sorted({s["k"] for s in by["skills"]
                          if not re.search(r"(?<![\w-])%s(?![\w-])" % re.escape(s["k"]), skills_src)}),
    }
    counts = {
        "macJobs": sum(1 for j in by["mac-jobs"] if j["s"] == "on"),
        "agentFiles": sum(1 for a in by["agent-files"] if a["s"] == "live"),
        "skills": len(by["skills"]),
        "workers": sum(1 for w in by["workers"] if w["s"] == "on"),
        "githubTimers": sum(1 for t in by["github-timers"] if t["s"] == "timer"),
        "scheduledTasks": sum(1 for t in by["scheduled-tasks"] if t["s"] in ("on", "inside daily-ops")),
    }
    inv = {"v": 1, "generatedAt": now.strftime("%Y-%m-%dT%H:%M:%SZ"), "counts": counts,
           "groups": groups, "missing": missing}
    return fit(inv)


def fit(inv, cap=PAYLOAD_CAP):
    """Shrink descriptions until the JSON fits the Airtable field. Says so when it did."""
    for chars in (None, 100, 50, 0):
        if chars is not None:
            for g in inv["groups"]:
                for it in g["items"]:
                    it["d"] = _short(it.get("d"), chars) if chars else ""
            inv["trimmed"] = chars
        if len(json.dumps(inv, separators=(",", ":"))) <= cap:
            return inv
    raise SourceFailure("the list is over %d characters even without descriptions" % cap)


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    inv = build()
    if "--json" in argv:
        print(json.dumps(inv, separators=(",", ":")))
    else:
        print(json.dumps({"counts": inv["counts"], "missing": inv["missing"],
                          "chars": len(json.dumps(inv, separators=(",", ":")))}, indent=1))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SourceFailure as exc:
        print("ERROR: %s" % exc, file=sys.stderr)
        sys.exit(1)
