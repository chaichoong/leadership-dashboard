#!/usr/bin/env python3
"""built_inventory.py — everything built, read from the files that run it.

WHY THIS EXISTS (Kevin, 29 Sep 2026): "something that lists everything we've
built that stays updated in real time, so we have a track record and a kind of
log of everything that we've built." The 29 Sep display audit found no such
list: the automations list and the Skills Library were kept by hand, about 20
automations rows were wrong, five Mac jobs and four GitHub timers were on no
page at all.

So this reads the real sources, never a list someone remembered to edit:
  Mac jobs         ~/Library/LaunchAgents (+ .parked), what launchd has loaded,
                   joined to scripts/job-schedule.json
  scheduled tasks  ~/.claude/scheduled-tasks/*/SKILL.md
  agent files      ~/.claude/agents/*.md
  skills           ~/.claude/skills, ~/.claude/skills/anthropic-skills, .claude/skills
  workers          workers/*/wrangler.toml, cloudflare-worker/, scripts/slack-automation/
  GitHub timers    .github/workflows/*.yml
The plain-English "what it does" line comes from js/automations-data.js where
one exists, else from the source's own description.

WHAT `missing` CAN AND CANNOT SAY. It checks both ways where a machine source
exists: running but not on the hand-kept lists, and listed but not found (Mac
jobs, workers, skills). It CANNOT see Airtable automations, workers whose code
lives outside this repo, or plugin skills, so the hand-kept lists still carry
things this does not. They are not redundant yet.

WHERE IT GOES. scripts/estate-status.py calls build() every ten minutes and
writes the result as the Payload of one PRIVATE Estate Status row
(`built-inventory`); the AI Agents page's Track record tab reads it. It is
never written into this repo: the repo is public and the descriptions name
creditors, tenants and legal work.

CONTROLS. Every source has a floor on what it PARSED, not on how many files
it saw. A wrong path, a moved folder, a front-matter format nobody reads or a
launchd environment that cannot see ~/Library would otherwise return nothing
and read as "the estate shrank". Any source under its floor raises
SourceFailure and the row goes red with the reason, instead of a shorter list.

Usage: python3 scripts/built_inventory.py [--json]
"""

import glob
import json
import os
import plistlib
import re
import subprocess
import sys
from datetime import datetime, timezone

HOME = os.environ.get("BUILT_HOME") or os.path.expanduser("~")
REPO = os.environ.get("BUILT_REPO") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# The Airtable long-text field holds 100,000 characters. Stay clear of it.
PAYLOAD_CAP = 90000
DESC_CHARS = 180

LABEL_PREFIXES = ("com.kevinbrittain.", "com.od.")

# Floors on PARSED rows, 29 Sep 2026 counts in brackets. A floor well under the
# real count catches a broken read, never a normal retirement.
FLOORS = {
    "macJobs": 20,          # (42 on)
    "scheduledTasks": 10,   # (27 parsed)
    "agentFiles": 10,       # (23 with front matter)
    "skills": 15,           # (34 with front matter)
    "workers": 5,           # (12 named)
    "githubTimers": 1,      # (4 on a timer)
}

# States that mean "not doing anything right now". Everything else is in use.
DIM_STATES = ("off", "parked", "retired", "paused", "not loaded", "not installed", "unreadable")


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
        with open(path, encoding="utf-8-sig") as fh:
            text = fh.read(20000)
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


# ─── the hand-kept automations list, read as data ─────────────────────
# A JS string literal in either quote style. Decoded with JSON's escape rules
# (JS and JSON share \n, \\, \uXXXX); \' is JS-only and handled first.
_JS_STR = r"""(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")"""


def _js_str(single, double):
    raw = double if double is not None else single.replace("\\'", "'")
    if double is None:
        raw = re.sub(r'(?<!\\)"', r'\\"', raw)
    try:
        return json.loads('"' + raw + '"')
    except ValueError:
        return raw


def _field(body, name):
    m = re.search(r"\b%s:\s*%s" % (name, _JS_STR), body, re.S)
    return _js_str(m.group(1), m.group(2)) if m else None


def automations_text():
    try:
        with open(os.path.join(REPO, "js", "automations-data.js"), encoding="utf-8") as fh:
            return fh.read()
    except OSError:
        return ""


def automation_entries(src):
    """key -> {name, what, status} for Mac jobs; name -> {what, status} for everything keyed by name."""
    jobs, named = {}, {}
    # Fields may come in any order (agent rows read `key, agent: true, name`).
    for m in re.finditer(r"\{\s*key:\s*" + _JS_STR + r"(.*?)\}", src, re.S):
        key, body = _js_str(m.group(1), m.group(2)), m.group(3)
        jobs[key] = {"name": _field(body, "name") or key, "what": _field(body, "what") or "",
                     "status": _field(body, "status") or ""}
    for m in re.finditer(r"\{\s*name:\s*" + _JS_STR + r"(.*?)\}", src, re.S):
        named[_js_str(m.group(1), m.group(2))] = {"what": _field(m.group(3), "what") or "",
                                                  "status": _field(m.group(3), "status") or ""}
    return jobs, named


# ─── Mac jobs ─────────────────────────────────────────────────────────
def load_schedule():
    try:
        with open(os.path.join(REPO, "scripts", "job-schedule.json")) as fh:
            return {k: v for k, v in json.load(fh).items() if isinstance(v, dict)}
    except (OSError, ValueError) as exc:
        raise SourceFailure("scripts/job-schedule.json could not be read: %s" % exc)


def loaded_labels():
    """Labels launchd has loaded, or None when that cannot be read (never an empty set)."""
    fake = os.environ.get("BUILT_LAUNCHCTL_LIST")
    if fake is not None:
        return {x for x in fake.split(",") if x} if fake != "none" else None
    try:
        out = subprocess.run(["/bin/launchctl", "list"], capture_output=True, text=True, timeout=20).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    labels = {line.split("\t")[-1].strip() for line in out.splitlines()[1:] if "\t" in line}
    return labels or None


def _when_plist(plist):
    if plist.get("KeepAlive") and not plist.get("StartCalendarInterval") and not plist.get("StartInterval"):
        return "always on"
    iv = plist.get("StartInterval")
    if iv:
        return "every %d s" % iv if iv < 60 else ("every %d min" % (iv // 60) if iv < 3600 else "every %g h" % (iv / 3600))
    cal = plist.get("StartCalendarInterval")
    if cal:
        cal = cal if isinstance(cal, list) else [cal]
        days = sorted({c["Weekday"] for c in cal if "Weekday" in c})
        times = sorted({"%02d:%02d" % (c.get("Hour", 0), c.get("Minute", 0)) for c in cal if "Hour" in c})
        text = ", ".join(times[:6]) + (" …" if len(times) > 6 else "") if times else \
            "hourly at :" + ", :".join("%02d" % m for m in sorted({c.get("Minute", 0) for c in cal})[:6])
        if days:
            names = "Sun Mon Tue Wed Thu Fri Sat Sun".split()
            text += " (" + ", ".join(names[d % 8] for d in days) + ")"
        return text
    if plist.get("RunAtLoad"):
        return "at login"
    return ""


def _key(label):
    for p in LABEL_PREFIXES:
        if label.startswith(p):
            return label[len(p):]
    return label


def mac_jobs(labels, schedule):
    agents = os.path.join(HOME, "Library", "LaunchAgents")
    parked_dir = os.path.join(HOME, "Library", "LaunchAgents.parked")
    loaded = loaded_labels()
    found = {}
    for folder, parked in ((agents, False), (parked_dir, True)):
        for path in sorted(glob.glob(os.path.join(folder, "*.plist"))):
            base = os.path.basename(path)
            if ".bak" in base or not base.startswith(LABEL_PREFIXES):
                continue
            try:
                with open(path, "rb") as fh:
                    pl = plistlib.load(fh)
                bad = None
            except Exception as exc:  # noqa: BLE001 — an unreadable plist is shown, not skipped
                pl, bad = {}, str(exc)[:120]
            label = pl.get("Label") or base[:-6]
            key = _key(label)
            if key in found:
                continue
            cfg = schedule.get(key, {})
            if bad:
                status = "unreadable"
            elif parked:
                status = "parked"
            elif cfg.get("enabled") is False:
                status = "off"
            elif loaded is not None and label not in loaded:
                status = "not loaded"
            else:
                status = "on"
            entry = labels.get(key, {})
            found[key] = {"k": key, "n": entry.get("name") or key, "w": cfg.get("cron") or _when_plist(pl),
                          "s": status, "d": _short(bad or entry.get("what")), "src": _rel(path),
                          "m": _modified(path), "label": label}
    live = [j for j in found.values() if j["s"] not in ("parked", "unreadable")]
    if len(live) < FLOORS["macJobs"]:
        raise SourceFailure("read %d Mac jobs in %s (expected %d+): the folder is not readable from here, "
                            "not an empty estate" % (len(live), _rel(agents), FLOORS["macJobs"]))
    # Loaded by launchd from a plist somewhere else (seen: content-engine-daytime).
    for label in sorted(loaded or ()):
        key = _key(label)
        if not label.startswith(LABEL_PREFIXES) or key in found:
            continue
        entry = labels.get(key, {})
        found[key] = {"k": key, "n": entry.get("name") or key, "w": schedule.get(key, {}).get("cron") or "",
                      "s": "on", "d": _short(entry.get("what")), "src": "launchctl (loaded from outside LaunchAgents)",
                      "m": None, "label": label}
    # In the schedule with no plist: a cooperative routine is the Claude
    # scheduler's (daily-ops); anything else should have a plist and has none.
    for key, cfg in schedule.items():
        if key.startswith("_") or key in found or not cfg.get("cron") or cfg.get("enabled") is False:
            continue
        entry = labels.get(key, {})
        coop = cfg.get("mode") == "cooperative"
        found[key] = {"k": key, "n": entry.get("name") or key, "w": cfg["cron"], "s": "on" if coop else "not installed",
                      "d": _short(entry.get("what")), "src": "scripts/job-schedule.json", "m": None,
                      "via": "Claude scheduler" if coop else "no launchd job found"}
    order = lambda j: (j["s"] in DIM_STATES, j["n"].lower())  # noqa: E731
    return sorted(found.values(), key=order)


# ─── the other sources ────────────────────────────────────────────────
def scheduled_tasks(schedule):
    rows, parsed = [], 0
    for path in sorted(glob.glob(os.path.join(HOME, ".claude", "scheduled-tasks", "*", "SKILL.md"))):
        fm = frontmatter(path)
        parsed += bool(fm)
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
    if parsed < FLOORS["scheduledTasks"]:
        raise SourceFailure("parsed %d scheduled-task instructions of %d files (expected %d+)"
                            % (parsed, len(rows), FLOORS["scheduledTasks"]))
    order = {"on": 0, "inside daily-ops": 1, "off": 2, "paused": 3, "retired": 4}
    return sorted(rows, key=lambda r: (order.get(r["s"], 9), r["n"].lower()))


def agent_files():
    rows = []
    for path in sorted(glob.glob(os.path.join(HOME, ".claude", "agents", "*.md"))):
        fm = frontmatter(path)
        slug = os.path.basename(path)[:-3]
        rows.append({"k": slug, "n": fm.get("name") or slug, "s": "live" if fm else "reference",
                     "d": _short(fm.get("description", "")), "src": _rel(path), "m": _modified(path)})
    live = sum(1 for r in rows if r["s"] == "live")
    if live < FLOORS["agentFiles"]:
        raise SourceFailure("parsed %d agent files of %d (expected %d+): their front matter is not being read"
                            % (live, len(rows), FLOORS["agentFiles"]))
    return rows


def skills():
    rows, parsed = [], 0
    places = ((os.path.join(HOME, ".claude", "skills", "*", "SKILL.md"), "global"),
              (os.path.join(HOME, ".claude", "skills", "anthropic-skills", "*", "SKILL.md"), "global"),
              (os.path.join(REPO, ".claude", "skills", "*", "SKILL.md"), "project"))
    for pattern, where in places:
        for path in sorted(glob.glob(pattern)):
            fm = frontmatter(path)
            parsed += bool(fm.get("name"))
            slug = os.path.basename(os.path.dirname(path))
            rows.append({"k": slug, "n": fm.get("name") or slug, "s": where, "d": _short(fm.get("description", "")),
                         "src": _rel(path), "m": _modified(path)})
    if parsed < FLOORS["skills"]:
        raise SourceFailure("parsed %d skills of %d files (expected %d+)" % (parsed, len(rows), FLOORS["skills"]))
    return sorted(rows, key=lambda r: (r["n"].lower(), r["s"]))


def _toml_top(text, key):
    for line in text.splitlines():
        if line.startswith("["):
            return None
        m = re.match(r"^%s\s*=\s*\"([^\"]*)\"" % key, line)
        if m:
            return m.group(1)
    return None


def workers(named):
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
        if crons:
            when, state = ", ".join(crons) + " (UTC)", "on"
        elif cm:
            when, state = "on request (its timer was removed)", "no timer"
        else:
            when, state = "on request", "on"
        rows.append({"k": name, "n": name, "w": when, "s": state,
                     "d": _short(named.get(name, {}).get("what")), "src": _rel(path), "m": _modified(path)})
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


# ─── the whole thing ──────────────────────────────────────────────────
def skills_library_names():
    """Skill slugs the Skills Library lists: its ids, and the last part of its commands."""
    try:
        with open(os.path.join(REPO, "js", "skills-data.js"), encoding="utf-8") as fh:
            src = fh.read()
    except OSError:
        return set()
    names = set(re.findall(r"\bid:\s*'([^']+)'", src))
    for cmd in re.findall(r"\bcommand:\s*'([^']+)'", src):
        names.add(cmd.split(":")[-1].lstrip("/"))
    return names


def build(now=None):
    now = now or datetime.now(timezone.utc)
    labels, named = automation_entries(automations_text())
    schedule = load_schedule()
    groups = [
        {"id": "mac-jobs", "title": "Scheduled jobs on the Mac", "items": mac_jobs(labels, schedule)},
        {"id": "agent-files", "title": "AI agent files", "items": agent_files()},
        {"id": "skills", "title": "Skills", "items": skills()},
        {"id": "workers", "title": "Cloudflare workers", "items": workers(named)},
        {"id": "github-timers", "title": "GitHub workflows", "items": github_timers()},
        {"id": "scheduled-tasks", "title": "Scheduled-task instructions", "items": scheduled_tasks(schedule)},
    ]
    by = {g["id"]: g["items"] for g in groups}
    mac_keys = {j["k"] for j in by["mac-jobs"]}
    library = skills_library_names()
    missing = {
        # running (or expected to run), but not on the hand-kept list
        "automations": sorted(j["k"] for j in by["mac-jobs"] if j["s"] == "on" and j["k"] not in labels),
        "workers": sorted(w["k"] for w in by["workers"] if w["k"] not in named),
        "skills": sorted({s["k"] for s in by["skills"] if s["k"] not in library}),
        # on the hand-kept list as running, but nothing on this Mac runs it
        "listedNotFound": sorted(k for k, e in labels.items() if e["status"] == "on" and k not in mac_keys),
        # in the job schedule, but launchd has no job for it
        "notInstalled": sorted(j["k"] for j in by["mac-jobs"] if j["s"] == "not installed"),
    }
    counts = {
        "macJobs": sum(1 for j in by["mac-jobs"] if j["s"] == "on"),
        "agentFiles": sum(1 for a in by["agent-files"] if a["s"] == "live"),
        "skills": len({s["k"] for s in by["skills"]}),
        "workers": sum(1 for w in by["workers"] if w["s"] not in DIM_STATES),
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
