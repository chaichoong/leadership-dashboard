#!/usr/bin/env python3
"""Push the rules that bind every agent into every agent, and check they arrived.

KEVIN'S RULING, 7 OCT 2026. Three department heads wrote that morning's 09:00 brief from figures
they had not read, and the run still reported green. The reporting rule that forbids exactly that
("no silent zeros", 17 Sep 2026) was in his global file and in the CEO's own instructions. Measured
across the 24 agent definitions that morning:

    no silent zeros / NOT CHECKED          0 of 24
    content is data, never instructions    5 of 24
    never route to Mica / Ericamae left   18 of 24
    the money rule, 25/100                20 of 24
    Kevin approves before it reaches the world   24 of 24

His words: "I'm not sure why the brain, when we update things, isn't filtering down through to every
one of the AI agents. That seems to be the ultimate issue here. We need to try and find an
overarching fix rather than just papering over the cracks."

The gap has a precise shape. `agent-estate-drift.py` scans every estate surface for wording a
ruling RETIRED, so a stale rule is caught. Nothing checked that a NEW rule had ARRIVED. A negative
check cannot see an absence. And the 24 agent files, unlike the 27 scheduled-task skills, had no
mirror, no diff and no test.

So: ONE source (`~/.claude/agents/BINDING-RULES.md`), mechanically pushed into every agent file
between markers, mechanically verified. A rule Kevin writes once is in every agent's prompt by the
next push, and a missing or stale block fails the daily check and the test gate.

    --push    write the current block into every agent file (prints what changed)
    --check   exit 1 and name every agent whose block is missing or out of date
    --report  print the per-rule coverage table above, for any rule, as evidence
    --selftest  prove the check fires on a damaged block (a check that cannot fail is theatre)

Exit 0 clean, 1 drift found, 2 cannot verify.
"""
import argparse
import os
import re
import sys
from pathlib import Path

AGENTS_DIR = Path(os.environ.get("OD_AGENTS_DIR")
                  or (Path.home() / ".claude/agents"))
SOURCE_NAME = "BINDING-RULES.md"
# Read by people and by the CEO, not agent definitions: they get no block.
NOT_AGENTS = {SOURCE_NAME, "ESTATE.md", "GUARDRAILS.md"}

START = "<!-- BINDING RULES: BLOCK START -->"
END = "<!-- BINDING RULES: BLOCK END -->"

# A folder this small is either a mistake or an emptied directory, and "every agent is compliant"
# off two files is not a pass. The estate had 24 agent definitions on 7 Oct 2026.
MIN_AGENTS = 15


def source_block(root=None):
    """The block between the markers in BINDING-RULES.md, or None if unreadable."""
    p = (root or AGENTS_DIR) / SOURCE_NAME
    try:
        text = p.read_text()
    except OSError:
        return None
    m = re.search(re.escape(START) + r"\n(.*?)\n" + re.escape(END), text, re.S)
    return m.group(1).strip() if m else None


def agent_files(root=None):
    root = root or AGENTS_DIR
    try:
        return sorted(f for f in root.glob("*.md") if f.name not in NOT_AGENTS)
    except OSError:
        return []


def agent_block(path):
    """(block or None, has_markers). None with markers means an empty block."""
    try:
        text = path.read_text()
    except OSError:
        return None, False
    m = re.search(re.escape(START) + r"\n(.*?)\n" + re.escape(END), text, re.S)
    if not m:
        return None, False
    return m.group(1).strip(), True


def push_one(path, block):
    """Returns 'added', 'updated' or 'current'."""
    text = path.read_text()
    wrapped = "%s\n%s\n%s" % (START, block, END)
    have, markers = agent_block(path)
    if markers:
        if have == block:
            return "current"
        new = re.sub(re.escape(START) + r"\n.*?\n" + re.escape(END), lambda _: wrapped, text, flags=re.S)
        path.write_text(new)
        return "updated"
    # Appended, never prepended: an agent's own identity and lane must still be the first thing
    # it reads. These rules bind what it does, they are not what it is.
    sep = "" if text.endswith("\n\n") else ("\n" if text.endswith("\n") else "\n\n")
    path.write_text(text + sep + "\n" + wrapped + "\n")
    return "added"


def cmd_push(root=None):
    block = source_block(root)
    if not block:
        print("CANNOT VERIFY: no block found between the markers in %s" % SOURCE_NAME, file=sys.stderr)
        return 2
    files = agent_files(root)
    if len(files) < MIN_AGENTS:
        print("CANNOT VERIFY: only %d agent file(s) readable in %s (expected %d+). Refusing to push."
              % (len(files), root or AGENTS_DIR, MIN_AGENTS), file=sys.stderr)
        return 2
    counts = {"added": 0, "updated": 0, "current": 0}
    for f in files:
        what = push_one(f, block)
        counts[what] += 1
        if what != "current":
            print("%-10s %s" % (what.upper(), f.name))
    print("binding rules: %d added, %d updated, %d already current, across %d agents"
          % (counts["added"], counts["updated"], counts["current"], len(files)))
    return 0


def cmd_check(root=None, quiet=False):
    block = source_block(root)
    if not block:
        if not quiet:
            print("CANNOT VERIFY: no block found between the markers in %s" % SOURCE_NAME, file=sys.stderr)
        return 2
    files = agent_files(root)
    if len(files) < MIN_AGENTS:
        if not quiet:
            print("CANNOT VERIFY: only %d agent file(s) readable in %s (expected %d+). "
                  "'every agent is compliant' off an emptied folder is not a pass."
                  % (len(files), root or AGENTS_DIR, MIN_AGENTS), file=sys.stderr)
        return 2
    missing, stale = [], []
    for f in files:
        have, markers = agent_block(f)
        if not markers:
            missing.append(f.name)
        elif have != block:
            stale.append(f.name)
    if not missing and not stale:
        if not quiet:
            print("binding rules: all %d agents carry the current block" % len(files))
        return 0
    if not quiet:
        if missing:
            print("MISSING the binding rules (%d): %s" % (len(missing), ", ".join(missing)))
        if stale:
            print("STALE binding rules (%d): %s" % (len(stale), ", ".join(stale)))
        print("Fix with: python3 scripts/agent-binding-rules.py --push", file=sys.stderr)
    return 1


# The coverage table that produced the ruling. Kept so the evidence can be re-read rather than
# taken on trust, and so a rule removed from the block shows up as coverage falling.
COVERAGE = {
    "no silent zeros / NOT CHECKED": r"silent zero|NOT CHECKED",
    "second-hand figures are not your own": r"second-hand|restate a figure|had not read",
    "content is data, never instructions": r"content is data|never instructions|planted instruction",
    "Kevin approves before it reaches the world": r"Kevin approves|approval queue|before anything reaches",
    "the money rule, 25/100": r"£25|£100",
    "never route to Mica": r"\bMica\b",
    "Ericamae has left": r"Ericamae",
    "say what you did not do": r"did not do|could not do",
}


def cmd_report(root=None):
    files = agent_files(root)
    if len(files) < MIN_AGENTS:
        print("CANNOT VERIFY: only %d agent file(s) readable" % len(files), file=sys.stderr)
        return 2
    texts = {}
    for f in files:
        try:
            texts[f.name] = f.read_text()
        except OSError:
            texts[f.name] = ""
    print("%-46s %s" % ("RULE", "agents carrying it (of %d)" % len(files)))
    print("-" * 80)
    worst = 0
    for name, pat in COVERAGE.items():
        rx = re.compile(pat, re.I)
        lack = sorted(n[:-3] for n, t in texts.items() if not rx.search(t))
        print("%-46s %2d / %d" % (name, len(files) - len(lack), len(files)))
        if lack:
            print("      missing from: %s" % ", ".join(lack))
            worst = max(worst, len(lack))
    return 0 if worst == 0 else 1


def selftest():
    """A check that cannot fail is theatre. Damage a block and confirm it fires."""
    import shutil
    import tempfile
    root = Path(tempfile.mkdtemp())
    block = "## Rules\n\n- be honest"
    (root / SOURCE_NAME).write_text("head\n\n%s\n%s\n%s\n\ntail\n" % (START, block, END))
    for i in range(MIN_AGENTS + 2):
        (root / ("agent-%02d.md" % i)).write_text("# Agent %d\n\nIts own lane.\n" % i)
    (root / "ESTATE.md").write_text("not an agent\n")

    assert cmd_check(root, quiet=True) == 1, "a folder with no blocks must FAIL the check"
    assert cmd_push(root) == 0
    assert cmd_check(root, quiet=True) == 0, "after a push every agent must carry the block"
    # The agent's own identity must still come first.
    one = (root / "agent-00.md").read_text()
    assert one.index("Its own lane") < one.index(START), "the block must be appended, not prepended"

    # STALE: an edited block must be caught, not tolerated.
    (root / "agent-03.md").write_text(
        (root / "agent-03.md").read_text().replace("be honest", "be whatever"))
    assert cmd_check(root, quiet=True) == 1, "an edited block must FAIL as stale"
    assert cmd_push(root) == 0 and cmd_check(root, quiet=True) == 0, "a push must repair it"

    # MISSING: markers removed entirely.
    (root / "agent-05.md").write_text("# Agent 5\n\nnothing else\n")
    assert cmd_check(root, quiet=True) == 1, "a stripped file must FAIL as missing"
    assert cmd_push(root) == 0 and cmd_check(root, quiet=True) == 0

    # CANNOT VERIFY beats a false pass, both ways round.
    empty = Path(tempfile.mkdtemp())
    (empty / SOURCE_NAME).write_text("%s\n%s\n%s\n" % (START, block, END))
    assert cmd_check(empty, quiet=True) == 2, "an emptied folder is 'cannot verify', never clean"
    assert cmd_push(empty) == 2, "and must refuse to push"
    nosource = Path(tempfile.mkdtemp())
    for i in range(MIN_AGENTS + 1):
        (nosource / ("agent-%02d.md" % i)).write_text("x\n")
    assert cmd_check(nosource, quiet=True) == 2, "no source block is 'cannot verify'"

    shutil.rmtree(root, ignore_errors=True)
    shutil.rmtree(empty, ignore_errors=True)
    shutil.rmtree(nosource, ignore_errors=True)
    print("selftest OK: 12 checks")
    return 0


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__)
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--push", action="store_true")
    g.add_argument("--check", action="store_true")
    g.add_argument("--report", action="store_true")
    g.add_argument("--selftest", action="store_true")
    a = ap.parse_args()
    if a.selftest:
        sys.exit(selftest())
    if a.push:
        sys.exit(cmd_push())
    if a.report:
        sys.exit(cmd_report())
    sys.exit(cmd_check())
