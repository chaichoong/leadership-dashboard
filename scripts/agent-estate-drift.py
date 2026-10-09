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

   Since 21 Sep 2026 the scan also reads what every Claude Code session loads
   before it acts: Kevin's global `~/.claude/CLAUDE.md` and the project memory
   folder (`MEMORY.md` and every topic `.md`). The agent files had been cleaned
   while the memory kept telling sessions to route to Mica and to post to
   #agent-approvals. Memory topic files deliberately keep history, so in a TOPIC
   file a dated marker line (`**SUPERSEDED in part (noted 21 Sep 2026):** ...`,
   `SUPERSEDED 16 Sep 2026: ...`) ends the scan of that file: what sits below
   it is the record, what sits above it is live. The marker must carry a date,
   so it records a ruling rather than acting as a mute switch. `MEMORY.md` and
   `~/.claude/CLAUDE.md` are loaded whole into every session, so they are fully
   live: a marker in either exempts nothing.

2. THE STAMP. `~/.claude/agents/ESTATE.md` carries `As at: YYYY-MM-DD`. Any
   ruling file in the brain's Decisions/ folder dated after that stamp whose
   text touches the estate (agents, approvals, routing, levels, the money rule,
   Slack, the huddle) means the estate file is behind a ruling. The fix is to
   fold the ruling in and bump the stamp, or bump the stamp after confirming the
   ruling changes nothing here.

CONTROLS, because a scan that sees nothing looks exactly like a clean scan:
- fewer than MIN_FILES readable estate surfaces exits 2 (cannot verify), never
  0; the memory topic files do not count toward that floor, so two hundred of
  them cannot hide an emptied agents folder;
- a missing `~/.claude/CLAUDE.md` or `MEMORY.md` is an unreadable surface (2);
- the retired list must fire on the built-in fixture (`--selftest`);
- a missing or unstamped ESTATE.md is an exception, not a pass;
- any unreadable surface, or a missing Decisions/ folder (the Drive mount is
  sometimes absent), exits 2. "0 rulings behind" off an empty folder is not a pass.

Exit 0 clean, 1 drift found (listed on stdout, summary on stderr), 2 cannot verify.
Runs daily as the wrapped launchd job `estate-drift` (06:25), and by hand:

    python3 scripts/agent-estate-drift.py            # scan the live estate
    python3 scripts/agent-estate-drift.py --selftest # prove the patterns fire
    python3 scripts/agent-estate-drift.py --json
"""
import argparse
import datetime as dt
import glob
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import brain_vault  # noqa: E402  the one twin rule, shared with the brain publisher

HOME = os.path.expanduser("~")
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BRAIN = os.path.join(HOME, "Library/CloudStorage/GoogleDrive-kevin@runpreneur.org.uk",
                     "My Drive/00 AI Context")
AGENTS = os.path.join(HOME, ".claude/agents")
SKILLS = os.path.join(HOME, ".claude/skills")
TASKS = os.path.join(HOME, ".claude/scheduled-tasks")
CLAUDE_MD = os.path.join(HOME, ".claude/CLAUDE.md")
MEMORY = os.path.join(HOME, ".claude/projects",
                      "-Users-kevinbrittain-Projects-leadership-dashboard", "memory")

MIN_FILES = 20

# (regex, retired on, what replaced it). Keep each pattern specific enough that
# it cannot match a sentence describing the rule as history. Add a line here in
# the same change that retires the rule; that is the whole protocol.
RETIRED = [
    (r"09:15 prospecting", "2026-09-27",
     "the prospecting slot is parked with Operations Director until January 2027"),
    (r"then Mica or Ericamae", "2026-08-25",
     "routing is AI only; property residue goes to Roy; Kevin is the last resort"),
    (r"Mica \(operations\), Ericamae \(marketing\)", "2026-08-25",
     "routing is AI only (Decisions/2026-08-25 Stop routing work to Mica and Ericamae)"),
    (r"Ericamae/Mica second", "2026-08-25",
     "routing is AI only; no human fallback except Roy for property"),
    (r"Human task \(Mica/Ericamae/Kevin\)", "2026-08-25",
     "tasks go to an AI agent or, fully prepared, to Kevin; never Mica or Ericamae"),
    (r"needs you or Mica", "2026-08-25",
     "an escalation off the agents needs Kevin; no work routes to Mica"),
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
    (r"Silent at zero", "2026-09-15",
     "the 08:00 DM goes every morning; with no cards it carries the content publishing line alone"),
    (r"Fifteen at 24 Aug 2026", "2026-09-07",
     "never state a register count in a prompt; the register is read live"),
    (r"Wickman's Integrator running Gary Keller", "2026-07-29",
     "the CEO is Dan Martell (org chart v3); Wickman heads Operations"),
    (r"Michalowicz cash, Jenyns systems, Martell AI-leverage", "2026-07-29",
     "the v2 seat list; the live board is the dept-* files in ~/.claude/agents/"),
    (r"Never an agent for a tier 1 or tier 2 matter", "2026-08-25",
     "tier 1 is PREPARED by an agent and lands with Kevin labelled; tier 2 no longer exists"),
    (r"Mica handles ALL creditor and debt correspondence", "2026-08-25",
     "the Supplier and Creditor Manager agent prepares every creditor matter; Kevin approves"),
    # Case-insensitive on purpose: the retired name appears as both "the
    # teardown call" and "The Teardown call" (dept-sales.md, 21 Sep 2026).
    (r"(?i)teardown call", "2026-07-31",
     "the sales call is the Operations Review Call, everywhere, with no exceptions"),
    # The blocker loop (Decisions/2026-09-25 Agent blockers are named, fixed and
    # resumed). Both lines told an agent how to STOP, never who fixes the wall.
    (r"The robot has no access to", "2026-09-25",
     "a site the robot cannot reach is a SITE wall: agent-dispatch.py block --kind SITE, and the task wakes when Kevin adds it"),
    (r"OPENS with 'PARKED:'", "2026-09-25",
     "a wall is recorded with agent-dispatch.py block and its kind; annotate refuses a PARKED note"),
    # Texts to tenants (Kevin, 5 Oct 2026: "Email-to-text"): GoHighLevel holds no Agile Lets location.
    (r"(?i)GoHighLevel number|texts? (go|goes|sent) (through|via|by) GoHighLevel", "2026-10-05",
     "texts go by ClickSend email-to-text from info@agilelets.co.uk, from the Agile Lets number +447984393339"),
    # Roy cannot send as info@ (Decisions/2026-10-06 Roy asks for help from his own Gmail, the
    # info@ assistant is paused): a line telling anyone Roy works by forwarding FROM info@.
    (r"(?i)Roy forwards? (a message |the message |a tenant'?s? \w+ |it )?FROM info@", "2026-10-06",
     "Roy emails info@ from his own Gmail and Inbox Triage works it; the info@-to-info@ door is paused"),
    # Every wall gets a door (Kevin, 7 Oct 2026): a protected-file fix is no longer a session
    # Kevin has to open. 19 TOOL walls sat behind this wording for up to twelve days.
    (r"(?i)a fix to a protected file needs a Claude Code session|needs? a Claude Code session to fix the robot",
     "2026-10-07",
     "the fixer opens the PR and a MERGE card comes to Kevin"),
    # The 1st-of-month rent due-date job reports and never writes (Decisions/2026-09-24 Property rulings
    # from the Book 4 audit, ruling 5). A blanket month forward hides exactly the tenancies that have not paid.
    (r"(?i)advances? rent due dates|advance it forward by one month", "2026-09-24",
     "the 1st-of-month rent due-date job is a read-only drift report: it counts blank and past dates and never writes one"),
    # The board trim (Kevin, 9 Oct 2026; Decisions/2026-10-09). Four heads stay: Strategy,
    # Operations (with systemisation), Finance (with wealth), Legal and Compliance. HR,
    # Productivity and Mindset retired; Marketing, Sales and the Writer parked to January.
    (r"(?i)\beleven(-seat)? (department )?(heads|seats|board)\b", "2026-10-09",
     "the board is four heads (Strategy, Operations, Finance, Legal and Compliance) and four workers"),
    (r"(?i)\ball eleven\b", "2026-10-09",
     "the board is four heads; convene the ones with live work"),
    (r"(?i)\bfive workers\b", "2026-10-09",
     "four workers: builder, auditor, analyst, researcher; the Writer is parked to January"),
    (r"dept-marketing, dept-sales", "2026-10-09",
     "the default huddle is dept-strategy and dept-operations; Marketing and Sales are parked to January"),
]

# A line that is describing the old rule, not stating it.
HISTORY = re.compile(
    r"(lowered from|back up to|previous rule|previously|superseded|supersedes|"
    r"kept for history|used to |no longer|retired|RETIRED|was \d|history)", re.I)
LESSON = re.compile(r"^\s*- 20\d\d-\d\d-\d\d:")
# In a memory TOPIC file, a line that OPENS with SUPERSEDED (after list, bold or
# heading marks) and carries a date marks everything below it as kept history.
# Upper case on purpose: prose that says "superseded" mid-sentence is not a
# marker. No date, no exemption.
SUPERSEDED = re.compile(
    r"^[\s#>*_-]*SUPERSEDED\b.*?"
    r"(\d{1,2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* 20\d\d"
    r"|20\d\d-\d\d-\d\d)")

ESTATE_WORDS = re.compile(
    r"\b(agent|agents|approval|approvals|gate|route|routing|autonomy|level [ABC]|"
    r"huddle|CEO|board|Slack|money rule|withdrawal|dispatch|register|workforce|"
    r"Mica|Ericamae|Roy)\b", re.I)


def surfaces(agents=AGENTS, skills=SKILLS, tasks=TASKS, brain=BRAIN, repo=REPO):
    files = sorted(glob.glob(os.path.join(agents, "*.md")))
    files += [os.path.join(skills, s, "SKILL.md") for s in ("ceo", "huddle", "agent-gate")]
    # daily-ops and monthly-rent-due-date since 9 Oct 2026: they carried the rent due-date write
    # that RETIRED now names, and a pattern no scan reads guards nothing.
    files += [os.path.join(tasks, t, "SKILL.md") for t in
              ("ceo-agent", "ceo-huddle", "ceo-memory-sweep", "agent-dispatch",
               "task-manager-board", "daily-ops", "monthly-rent-due-date")]
    files += [os.path.join(brain, p) for p in
              ("founder-profile.md", "current-priorities.md",
               "constraints-and-red-lines.md", "Knowledge/escalation-policy.md",
               "Knowledge/daily-triage-doctrine.md")]
    files += [os.path.join(repo, "scripts/slack-automation/money-daily-worker.js")]
    return files


def memory_surfaces(claude_md=CLAUDE_MD, memory=MEMORY):
    """Kevin's global CLAUDE.md, then MEMORY.md, then every memory topic file.
    The first two are named outright so a missing one reads as unreadable."""
    index = os.path.join(memory, "MEMORY.md")
    topics = [p for p in sorted(glob.glob(os.path.join(memory, "*.md"))) if p != index]
    return [claude_md, index] + topics


def keeps_history(path, memory=MEMORY):
    """True for a memory TOPIC file, the only kind whose SUPERSEDED marker
    exempts what follows it. MEMORY.md and ~/.claude/CLAUDE.md are fully live."""
    return (os.path.dirname(os.path.abspath(path)) == os.path.abspath(memory)
            and os.path.basename(path) != "MEMORY.md")


def scan_text(text, path, retired=RETIRED, history_below_marker=False):
    """Every line of `text` against RETIRED. A Lessons line is exempt outright.
    A history word exempts a match only when it comes BEFORE the match on the
    line ("lowered from £50/£250"); a stale rule followed by an unrelated
    "retired" later in the sentence still fires (review finding, 7 Sep 2026).
    With `history_below_marker` (memory topic files only) the scan stops at the
    first dated SUPERSEDED marker line: below it is the record, not a rule."""
    hits = []
    for n, line in enumerate(text.splitlines(), 1):
        if history_below_marker and SUPERSEDED.match(line):
            break
        if LESSON.match(line):
            continue
        hist = HISTORY.search(line)
        for pat, since, fix in retired:
            m = re.search(pat, line)
            if not m:
                continue
            if hist and hist.start() < m.start():
                continue
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


LOOKBACK_DAYS = 14


def _squash(text):
    """Whitespace squashed to single spaces, so a file name wrapped across two
    lines of ESTATE.md still counts as named."""
    return " ".join((text or "").split())


def rulings_after(stamp, decisions_dir, estate_text=""):
    """Decisions files that the estate page has not absorbed.

    A file dated AFTER the stamp always counts as behind. A file dated on the
    stamp day or in the 14 days before it counts as absorbed only when
    ESTATE.md names it (Kevin, 2 Oct 2026). The old rule looked back zero days,
    so a ruling written after the page was stamped but dated a day or more
    earlier — a decision minuted late, which is the normal case — was invisible
    for ever. The window is bounded so the check never re-raises the whole
    archive, and names are compared with whitespace squashed because ESTATE.md
    wraps long lines."""
    floor = (dt.date.fromisoformat(stamp) - dt.timedelta(days=LOOKBACK_DAYS)).isoformat()
    page = _squash(estate_text)
    out = []
    for p in sorted(glob.glob(os.path.join(decisions_dir, "*.md"))):
        # A Drive sync twin ("<ruling> 2.md") is a copy, not a second ruling, and
        # ESTATE.md never names it, so it would fire as unabsorbed (29 Sep 2026).
        if brain_vault.is_twin(p):
            continue
        name = os.path.basename(p)
        m = re.match(r"(\d{4}-\d{2}-\d{2})", name)
        if not m or m.group(1) < floor:
            continue
        if m.group(1) <= stamp and _squash(name[:-3]) in page:
            continue
        try:
            with open(p) as f:
                body = f.read(6000)
        except OSError:
            continue
        if ESTATE_WORDS.search(name) or ESTATE_WORDS.search(body):
            out.append(name)
    return out


def run(agents=AGENTS, skills=SKILLS, tasks=TASKS, brain=BRAIN, repo=REPO,
        claude_md=CLAUDE_MD, memory=MEMORY):
    res = {"hits": [], "stamp": None, "rulings_behind": [], "files_scanned": 0,
           "memory_files_scanned": 0, "files_missing": []}
    core = surfaces(agents, skills, tasks, brain, repo)
    for p in core + memory_surfaces(claude_md, memory):
        try:
            with open(p) as f:
                text = f.read()
        except OSError:
            res["files_missing"].append(p)
            continue
        res["files_scanned"] += 1
        if p not in core:
            res["memory_files_scanned"] += 1
        res["hits"] += scan_text(text, p,
                                 history_below_marker=keeps_history(p, memory))
    estate_read = res["files_scanned"] - res["memory_files_scanned"]
    if estate_read < MIN_FILES:
        return 2, dict(res, reason="only %d estate surfaces readable (floor %d)"
                       % (estate_read, MIN_FILES))
    # A surface that cannot be read is a scan that cannot see it. The brain
    # lives on a Drive mount that is sometimes absent; with it gone the five
    # brain files and Decisions/ vanish and the old version printed
    # "0 rulings behind" and exited 0 (review finding, 7 Sep 2026).
    decisions = os.path.join(brain, "Decisions")
    if res["files_missing"] or not os.path.isdir(decisions):
        missing = list(res["files_missing"])
        if not os.path.isdir(decisions):
            missing.append(decisions)
        return 2, dict(res, reason="%d surface(s) unreadable: %s"
                       % (len(missing), ", ".join(
                           m.replace(HOME, "~") for m in missing)))
    estate = os.path.join(agents, "ESTATE.md")
    res["stamp"] = stamp_of(estate)
    if not res["stamp"]:
        res["hits"].append({"file": estate, "line": 0, "pattern": "As at:",
                            "retired": "", "fix": "ESTATE.md missing or has no "
                            "'As at: YYYY-MM-DD' stamp", "text": ""})
    else:
        try:
            with open(estate) as f:
                estate_text = f.read()
        except OSError:
            estate_text = ""
        res["rulings_behind"] = rulings_after(res["stamp"], decisions, estate_text)
    code = 1 if (res["hits"] or res["rulings_behind"]) else 0
    return code, res


FIXTURE = """# fixture
- 2026-08-27: INBOUND: something — under £50 act, said Kevin
Previous rule, kept for history: under £50 act; over £250 escalate.
Delegation order: AI first, then Mica or Ericamae, then Kevin.
Verify the card posted by reading #agent-approvals.
Spending over £250 escalate.
Delegation: AI first, then Mica or Ericamae, then Kevin (Slack cards retired 1 Sep).
"""


def selftest():
    hits = scan_text(FIXTURE, "fixture")
    lines = sorted(set(h["line"] for h in hits))
    # Line 2 is a lesson and line 3 quotes the old rule after a history word:
    # both exempt even though both contain retired wording. 4, 5, 6 fire. Line
    # 7 fires too: its history word comes AFTER the stale rule.
    assert lines == [4, 5, 6, 7], "selftest: expected hits on 4,5,6,7 got %s" % lines
    assert not scan_text("Route to the Supplier and Creditor Manager agent.", "x")
    assert scan_text("Use for the teardown call.", "x")
    assert scan_text("The Teardown Call runs first.", "x")
    # Texts to tenants (5 Oct 2026): the GoHighLevel route fires; GoHighLevel itself, for OD sales, does not.
    assert scan_text("Texts go from the Agile Lets GoHighLevel number.", "x")
    assert scan_text("Each text goes through GoHighLevel to the tenant.", "x")
    assert not scan_text("Sales follow-ups run in GoHighLevel workflows for Operations Director.", "x")
    # Roy's requests (6 Oct 2026): the old front door fires; his Gmail route does not.
    assert scan_text("Roy forwards a message FROM info@agilelets.co.uk TO itself.", "x")
    assert scan_text("Roy forwards from info@ to info@ with one line.", "x")
    assert not scan_text("Roy emails info@ from his own Gmail and Inbox Triage works it.", "x")
    # Every wall gets a door (7 Oct 2026): the dead-end wording fires; the MERGE card route does not.
    assert scan_text("TOOL: the setup is repaired; a fix to a protected file needs a Claude Code session.", "x")
    assert scan_text("3 tasks need a Claude Code session to fix the robot.", "x")
    assert not scan_text("For a protected file, the fixer opens the PR and a MERGE card comes to Kevin.", "x")
    assert not scan_text("Kevin opened a Claude Code session on the Mac mini.", "x")
    # The rent due-date job reports only (24 Sep 2026): the write wording fires; the report wording does not.
    assert scan_text("  Advances rent due dates for every active tenancy.", "x")
    assert scan_text("4. If it is in the past, advance it forward by one month", "x")
    assert not scan_text("A read-only drift report on rent due dates. It never writes a date.", "x")
    assert not scan_text("4. Write nothing. A past date is the arrears signal, never something to advance.", "x")
    assert stamp_of(os.devnull) is None
    assert rulings_after("2026-09-07", os.devnull) == []
    memory_selftest()
    print("selftest ok: %d retired patterns, fixture fires on lines 4, 5, 6, 7; "
          "memory rule: CLAUDE.md and MEMORY.md live, topic history below a "
          "dated SUPERSEDED marker exempt" % len(RETIRED))
    return 0


STALE = "Delegation order: AI first, then Mica or Ericamae, then Kevin."
MARKER = ("**SUPERSEDED in part (noted 21 Sep 2026):** no work routes to Mica "
          "since 25 Aug 2026. The order below is history.")


def memory_selftest():
    """Drive the real file-level rule on a throwaway ~/.claude layout."""
    import tempfile
    with tempfile.TemporaryDirectory() as root:
        memory = os.path.join(root, "memory")
        os.makedirs(memory)
        claude_md = os.path.join(root, "CLAUDE.md")
        files = {
            claude_md: "# global\n%s\n" % STALE,
            os.path.join(memory, "MEMORY.md"): "- index\n%s\n%s\n" % (MARKER, STALE),
            os.path.join(memory, "topic_history.md"): "# t\n%s\n%s\n" % (MARKER, STALE),
            os.path.join(memory, "topic_live.md"): "# t\n%s\n%s\n" % (STALE, MARKER),
            os.path.join(memory, "topic_undated.md"):
                "# t\n**SUPERSEDED:** see below.\n%s\n" % STALE,
        }
        for p, body in files.items():
            with open(p, "w") as f:
                f.write(body)
        got = {}
        for p in memory_surfaces(claude_md, memory):
            with open(p) as f:
                got[os.path.basename(p)] = [h["line"] for h in scan_text(
                    f.read(), p, history_below_marker=keeps_history(p, memory))]
    # A retired phrase in ~/.claude/CLAUDE.md fires.
    assert got["CLAUDE.md"] == [2], "selftest: CLAUDE.md %s" % got["CLAUDE.md"]
    # MEMORY.md is fully live: its marker exempts nothing.
    assert got["MEMORY.md"] == [3], "selftest: MEMORY.md %s" % got["MEMORY.md"]
    # The same phrase under a dated marker in a topic file is history.
    assert got["topic_history.md"] == [], "selftest: history %s" % got["topic_history.md"]
    # Above the marker it is still a live instruction.
    assert got["topic_live.md"] == [2], "selftest: live %s" % got["topic_live.md"]
    # An undated marker is a mute switch, not a record: it exempts nothing.
    assert got["topic_undated.md"] == [3], "selftest: undated %s" % got["topic_undated.md"]


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("--json", action="store_true")
    p.add_argument("--selftest", action="store_true")
    p.add_argument("--agents", default=AGENTS)
    p.add_argument("--skills", default=SKILLS)
    p.add_argument("--tasks", default=TASKS)
    p.add_argument("--brain", default=BRAIN)
    p.add_argument("--repo", default=REPO)
    p.add_argument("--claude-md", default=CLAUDE_MD)
    p.add_argument("--memory", default=MEMORY)
    a = p.parse_args(argv)
    if a.selftest:
        return selftest()
    code, res = run(a.agents, a.skills, a.tasks, a.brain, a.repo,
                    a.claude_md, a.memory)
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
    # CHECK 3 — DID THE NEW RULE ARRIVE? (Kevin, 7 Oct 2026)
    #
    # Checks 1 and 2 are both NEGATIVE: retired wording must be gone, and ESTATE.md must not be
    # behind a ruling. Neither can see an ABSENCE. On 7 Oct the reporting rule that forbids
    # presenting an unread figure as checked was in Kevin's global file and in the CEO's own
    # instructions, and in 0 of the 24 agent definitions — so three heads wrote that morning's
    # brief from figures they had not read and the run reported green. His ruling: find the
    # overarching fix, not another patch. This is the positive half.
    binding = binding_rules_verdict()
    if not a.json and binding["code"]:
        print(binding["message"])
    if binding["code"] == 2 and code == 0:
        print("CANNOT VERIFY: %s" % binding["message"], file=sys.stderr)
        return 2
    if binding["code"] == 1:
        code = code or 1

    summary = ("estate drift: %d stale lines, %d rulings behind, %d agents missing the binding "
               "rules, %d files scanned (%d of them CLAUDE.md and memory)"
               % (len(res["hits"]), len(res["rulings_behind"]), binding["offenders"],
                  res["files_scanned"], res["memory_files_scanned"]))
    # In --json mode stdout is the JSON document and nothing else, or the caller
    # cannot parse a clean run (the first version printed the summary after it).
    print(summary, file=sys.stderr if (code or a.json) else sys.stdout)
    return code


def binding_rules_verdict():
    """Check 3: every agent carries the current block from BINDING-RULES.md.

    Delegated to scripts/agent-binding-rules.py rather than reimplemented, so the daily job and
    the test gate can never disagree with the pusher about what "current" means.
    """
    import importlib.util
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "agent-binding-rules.py")
    try:
        spec = importlib.util.spec_from_file_location("agent_binding_rules", path)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
    except Exception as exc:                                    # noqa: BLE001 - any failure here is "cannot verify"
        return {"code": 2, "offenders": 0,
                "message": "the binding-rules check could not be loaded (%s)" % str(exc)[:200]}
    block = mod.source_block()
    files = mod.agent_files()
    if not block:
        return {"code": 2, "offenders": 0,
                "message": "no binding-rules block found in %s" % mod.SOURCE_NAME}
    if len(files) < mod.MIN_AGENTS:
        return {"code": 2, "offenders": 0,
                "message": "only %d agent file(s) readable (expected %d+); "
                           "'every agent is compliant' off an emptied folder is not a pass"
                           % (len(files), mod.MIN_AGENTS)}
    bad = []
    for f in files:
        have, markers = mod.agent_block(f)
        if not markers or have != block:
            bad.append(f.name)
    if not bad:
        return {"code": 0, "offenders": 0,
                "message": "binding rules: all %d agents current" % len(files)}
    return {"code": 1, "offenders": len(bad),
            "message": ("BINDING RULES missing or stale in %d of %d agents: %s\n"
                        "       Fix with: python3 scripts/agent-binding-rules.py --push"
                        % (len(bad), len(files), ", ".join(bad)))}


if __name__ == "__main__":
    sys.exit(main())
