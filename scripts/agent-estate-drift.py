#!/usr/bin/env python3
"""Agent estate drift: are the CEO, the board and the files they read still current?

Kevin, 7 Sep 2026: "I haven't really been using my CEO at all because I felt that he
is outdated." The audit that day found the CEO's own file was fresh but the door
Kevin talks to him through (the /ceo skill), the four brain files the CEO loads
first, the 09:00 brief worker's prompt, the huddle instructions and eight of the
eleven department heads still carried rules retired between 25 Aug and 7 Sep. On
4 Sep the 09:00 brief handed a credit card payment to Mica, which the 25 Aug
ruling forbids. Nothing errored. A prompt does not know it is stale.

This script is the mechanical half of the fix. Two checks:

1. RETIRED PHRASES. Every file the strategic layer reads or runs on is scanned
   for wording that a dated ruling retired. Each entry says what replaced it, so
   a hit is a one-line fix, never a research job. A "Lessons from Kevin" line is
   exempt (a lesson is never deleted), and so is a line that quotes the old rule
   as history ("lowered from", "superseded", "previous rule").

2. THE STAMP. `~/.claude/agents/ESTATE.md` carries `As at: YYYY-MM-DD`. Any
   ruling file in the brain's Decisions/ folder dated after that stamp whose
   text touches the estate (agents, approvals, routing, levels, the money rule,
   Slack, the huddle) means the estate file is behind a ruling. The fix is to
   fold the ruling in and bump the stamp, or bump the stamp after confirming the
   ruling changes nothing here.

CONTROLS, because a scan that sees nothing looks exactly like a clean scan:
- fewer than MIN_FILES readable surfaces exits 2 (cannot verify), never 0;
- the retired list must fire on the built-in fixture (`--selftest`);
- a missing or unstamped ESTATE.md is an exception, not a pass.

Exit 0 clean, 1 drift found (listed on stdout, summary on stderr), 2 cannot verify.
Runs daily as the wrapped launchd job `estate-drift` (06:25), and by hand:

    python3 scripts/agent-estate-drift.py            # scan the live estate
    python3 scripts/agent-estate-drift.py --selftest # prove the patterns fire
    python3 scripts/agent-estate-drift.py --json
"""
import argparse
import glob
import json
import os
import re
import sys

HOME = os.path.expanduser("~")
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BRAIN = os.path.join(HOME, "Library/CloudStorage/GoogleDrive-kevin@runpreneur.org.uk",
                     "My Drive/00 AI Context")
AGENTS = os.path.join(HOME, ".claude/agents")
SKILLS = os.path.join(HOME, ".claude/skills")
TASKS = os.path.join(HOME, ".claude/scheduled-tasks")

MIN_FILES = 20

# (regex, retired on, what replaced it). Keep each pattern specific enough that
# it cannot match a sentence describing the rule as history. Add a line here in
# the same change that retires the rule; that is the whole protocol.
RETIRED = [
    (r"then Mica or Ericamae", "2026-08-25",
     "routing is AI only; property residue goes to Roy; Kevin is the last resort"),
    (r"Mica \(operations\), Ericamae \(marketing\)", "2026-08-25",
     "routing is AI only (Decisions/2026-08-25 Stop routing work to Mica and Ericamae)"),
    (r"Ericamae/Mica second", "2026-08-25",
     "routing is AI only; no human fallback except Roy for property"),
    (r"Human task \(Mica/Ericamae/Kevin\)", "2026-08-25",
     "tasks go to an AI agent or, fully prepared, to Kevin; never Mica or Ericamae"),
    (r"^\s*\d\.\s+Mica\s+[—-]", "2026-08-25",
     "Mica is not a delegation destination"),
    (r"^\s*\d\.\s+Ericamae\s+[—-]", "2026-08-25",
     "Ericamae is not a delegation destination"),
    (r"#agent-approvals", "2026-09-01",
     "Kevin decides in the dashboard approval queue (os/agents/index.html#tab=approvals); Slack cards are retired"),
    (r"approves by ✅", "2026-09-01",
     "approval happens in the dashboard queue, never by emoji"),
    (r"makes the Slack card appear", "2026-09-01",
     "a submit reaches the dashboard queue and the 08:00 digest; there is no card"),
    (r"one tap in Slack", "2026-09-01",
     "one tap in the approval queue on the AI Agents page"),
    (r"under £50 act", "2026-09-07",
     "money rule is £25 / £100 (GUARDRAILS.md, Autonomy levels)"),
    (r"£50 to £250", "2026-09-07",
     "money rule is £25 to £100 act and inform"),
    (r"over £250 escalate", "2026-09-07",
     "over £100 is a card; recurring is always Kevin's"),
    (r"£50/£250 thresholds", "2026-09-07",
     "the £25/£100 thresholds"),
    (r"Fifteen at 24 Aug 2026", "2026-09-07",
     "never state a register count in a prompt; the register is read live"),
    (r"Wickman's Integrator running Gary Keller", "2026-07-29",
     "the CEO is Dan Martell (org chart v3); Wickman heads Operations"),
    (r"Michalowicz cash, Jenyns systems, Martell AI-leverage", "2026-07-29",
     "the v2 seat list; the live board is the eleven heads in ~/.claude/agents/"),
    (r"Never an agent for a tier 1 or tier 2 matter", "2026-08-25",
     "tier 1 is PREPARED by an agent and lands with Kevin labelled; tier 2 no longer exists"),
    (r"Mica handles ALL creditor and debt correspondence", "2026-08-25",
     "the Supplier and Creditor Manager agent prepares every creditor matter; Kevin approves"),
]

# A line that is describing the old rule, not stating it.
HISTORY = re.compile(
    r"(lowered from|back up to|previous rule|previously|superseded|supersedes|"
    r"kept for history|used to |no longer|retired|RETIRED|was \d|history)", re.I)
LESSON = re.compile(r"^\s*- 20\d\d-\d\d-\d\d:")

ESTATE_WORDS = re.compile(
    r"\b(agent|agents|approval|approvals|gate|route|routing|autonomy|level [ABC]|"
    r"huddle|CEO|board|Slack|money rule|withdrawal|dispatch|register|workforce|"
    r"Mica|Ericamae|Roy)\b", re.I)


def surfaces(agents=AGENTS, skills=SKILLS, tasks=TASKS, brain=BRAIN, repo=REPO):
    files = sorted(glob.glob(os.path.join(agents, "*.md")))
    files += [os.path.join(skills, s, "SKILL.md") for s in ("ceo", "huddle", "agent-gate")]
    files += [os.path.join(tasks, t, "SKILL.md") for t in
              ("ceo-agent", "ceo-huddle", "ceo-memory-sweep", "agent-dispatch",
               "task-manager-board")]
    files += [os.path.join(brain, p) for p in
              ("founder-profile.md", "current-priorities.md",
               "constraints-and-red-lines.md", "Knowledge/escalation-policy.md",
               "Knowledge/daily-triage-doctrine.md")]
    files += [os.path.join(repo, "scripts/slack-automation/money-daily-worker.js")]
    return files


def scan_text(text, path, retired=RETIRED):
    hits = []
    for n, line in enumerate(text.splitlines(), 1):
        if LESSON.match(line) or HISTORY.search(line):
            continue
        for pat, since, fix in retired:
            if re.search(pat, line):
                hits.append({"file": path, "line": n, "pattern": pat,
                             "retired": since, "fix": fix,
                             "text": line.strip()[:140]})
    return hits


def stamp_of(estate_path):
    try:
        with open(estate_path) as f:
            head = f.read(4000)
    except OSError:
        return None
    m = re.search(r"As at:\s*(\d{4}-\d{2}-\d{2})", head)
    return m.group(1) if m else None


def rulings_after(stamp, decisions_dir):
    """Decisions files dated after the stamp whose text touches the estate."""
    out = []
    for p in sorted(glob.glob(os.path.join(decisions_dir, "*.md"))):
        name = os.path.basename(p)
        m = re.match(r"(\d{4}-\d{2}-\d{2})", name)
        if not m or m.group(1) <= stamp:
            continue
        try:
            with open(p) as f:
                body = f.read(6000)
        except OSError:
            continue
        if ESTATE_WORDS.search(name) or ESTATE_WORDS.search(body):
            out.append(name)
    return out


def run(agents=AGENTS, skills=SKILLS, tasks=TASKS, brain=BRAIN, repo=REPO):
    res = {"hits": [], "stamp": None, "rulings_behind": [], "files_scanned": 0,
           "files_missing": []}
    for p in surfaces(agents, skills, tasks, brain, repo):
        try:
            with open(p) as f:
                text = f.read()
        except OSError:
            res["files_missing"].append(p)
            continue
        res["files_scanned"] += 1
        res["hits"] += scan_text(text, p)
    if res["files_scanned"] < MIN_FILES:
        return 2, dict(res, reason="only %d surfaces readable (floor %d)"
                       % (res["files_scanned"], MIN_FILES))
    estate = os.path.join(agents, "ESTATE.md")
    res["stamp"] = stamp_of(estate)
    if not res["stamp"]:
        res["hits"].append({"file": estate, "line": 0, "pattern": "As at:",
                            "retired": "", "fix": "ESTATE.md missing or has no "
                            "'As at: YYYY-MM-DD' stamp", "text": ""})
    else:
        res["rulings_behind"] = rulings_after(res["stamp"],
                                              os.path.join(brain, "Decisions"))
    code = 1 if (res["hits"] or res["rulings_behind"]) else 0
    return code, res


FIXTURE = """# fixture
- 2026-08-27: INBOUND: something — Send from kevinbrittain@gmail.com
The money rule was lowered from £50/£250 while the cards are paid down.
Delegation order: AI first, then Mica or Ericamae, then Kevin.
Verify the card posted by reading #agent-approvals.
Spending over £250 escalate.
"""


def selftest():
    hits = scan_text(FIXTURE, "fixture")
    lines = sorted(h["line"] for h in hits)
    # Line 2 is a lesson, line 3 is history: both exempt. 4, 5, 6 must fire.
    assert lines == [4, 5, 6], "selftest: expected hits on lines 4,5,6 got %s" % lines
    assert not scan_text("Route to the Supplier and Creditor Manager agent.", "x")
    assert stamp_of(os.devnull) is None
    print("selftest ok: %d retired patterns, fixture fires on lines 4, 5, 6"
          % len(RETIRED))
    return 0


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("--json", action="store_true")
    p.add_argument("--selftest", action="store_true")
    p.add_argument("--agents", default=AGENTS)
    p.add_argument("--skills", default=SKILLS)
    p.add_argument("--tasks", default=TASKS)
    p.add_argument("--brain", default=BRAIN)
    p.add_argument("--repo", default=REPO)
    a = p.parse_args(argv)
    if a.selftest:
        return selftest()
    code, res = run(a.agents, a.skills, a.tasks, a.brain, a.repo)
    if a.json:
        print(json.dumps(res, indent=2))
    if code == 2:
        print("CANNOT VERIFY: %s" % res["reason"], file=sys.stderr)
        return 2
    if not a.json:
        for h in res["hits"]:
            print("STALE  %s:%d  [%s]  ->  %s\n       %s"
                  % (h["file"].replace(HOME, "~"), h["line"], h["retired"],
                     h["fix"], h["text"]))
        for r in res["rulings_behind"]:
            print("BEHIND ESTATE.md (as at %s) has not absorbed: %s"
                  % (res["stamp"], r))
    summary = ("estate drift: %d stale lines, %d rulings behind, %d files scanned"
               % (len(res["hits"]), len(res["rulings_behind"]), res["files_scanned"]))
    # In --json mode stdout is the JSON document and nothing else, or the caller
    # cannot parse a clean run (the first version printed the summary after it).
    print(summary, file=sys.stderr if (code or a.json) else sys.stdout)
    return code


if __name__ == "__main__":
    sys.exit(main())
