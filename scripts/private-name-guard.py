#!/usr/bin/env python3
"""
Private-name guard: refuses a commit whose staged changes ADD a line that names a
person on the private roster (~/.config/od/redact-names.txt, override with
$OD_REDACT_NAMES).

THIS REPO IS PUBLIC. Private working files kept landing in the checkout: 258 loose
files on 21 Sep 2026 (HMRC page builders, arrears workings, letter drafts, ledger
dumps), after .gitignore had been widened four times since 31 Jul 2026 and still
matched none of them. Ignore patterns guess at file NAMES. This guard reads what is
actually being committed, so a file nobody thought to ignore is still stopped.

Only ADDED lines are read. A tracked file that already mentions someone on an
unchanged line does not block an unrelated edit to that file.

The roster matching is report_scrub's: full names only (a single word collides with
ordinary text), Kevin's own name allowed. A missing roster warns loudly and lets the
commit through, because there is nothing to check against.

Run by scripts/pre-commit before the pageVer bump. Standalone:
    python3 scripts/private-name-guard.py      # checks the staged changes; exit 1 on a hit

COMMIT MESSAGES (29 Sep 2026)
The staged diff is not the only thing a commit publishes. On 29 Sep 2026 commit
messages on origin/main were found naming tenants and property addresses: the
guard above never saw them. `--message-file PATH` checks a commit message
against the same roster, and scripts/commit-msg runs it for every commit:
    python3 scripts/private-name-guard.py --message-file .git/COMMIT_EDITMSG
Everything below the scissors line `git commit -v` adds is the diff, not the
message, so it is not read (a commit that REMOVES a name would otherwise be
refused for quoting it). A missing roster warns and lets the commit through,
exactly as the staged-diff check does.

A squash merge on GitHub writes a message no local hook sees: it is built from
the PR title, body and commit messages. scripts/merge-pr.py checks those with
fields_naming() below before it merges.

KNOWN LIMIT: full names only, by design. A first name on its own ("rent from
Jane") is not caught, because single words collide with ordinary text.
"""

import argparse
import os
import re
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
from report_scrub import compile_names, load_roster, roster_path  # noqa: E402

MAX_REPORTED = 20


def added_lines(diff_text):
    """Yield (path, line_no, text) for every added line in a `git diff -U0`.

    '+++ ' is a file header only between 'diff --git' and the first '@@'. After
    that it is an added line whose own text starts with '++ ', which must still
    be checked, not mistaken for a header.
    """
    path = None
    line_no = 0
    in_header = False
    for raw in diff_text.splitlines():
        if raw.startswith('diff --git '):
            in_header = True
            path = None
            continue
        if in_header:
            if raw.startswith('+++ '):
                target = raw[4:]
                path = None if target == '/dev/null' else (target[2:] if target.startswith('b/') else target)
                continue
            elif raw.startswith('@@'):
                in_header = False
            else:
                continue
        if raw.startswith('@@'):
            m = re.search(r'\+(\d+)', raw)
            line_no = int(m.group(1)) if m else 0
            continue
        if raw.startswith('+') and path:
            yield path, line_no, raw[1:]
            line_no += 1


def staged_diff():
    result = subprocess.run(
        ['git', 'diff', '--cached', '-U0', '--no-color', '--no-ext-diff',
         '--diff-filter=ACMR'],
        capture_output=True, text=True, errors='replace',
    )
    if result.returncode != 0:
        print(f"private-name guard: git diff failed: {result.stderr.strip()}", file=sys.stderr)
        sys.exit(1)
    return result.stdout


def find_hits(diff_text, pattern):
    return [(path, line_no) for path, line_no, text in added_lines(diff_text)
            if pattern.search(text)]


def roster_pattern():
    """(compiled pattern, None), or (None, why) when there is no roster to check against."""
    names = load_roster()
    if not names:
        return None, f"no roster at {roster_path()}"
    return compile_names(names), None


# The line `git commit -v` (and --cleanup=scissors) puts above the diff it shows
# in the editor. The first character is git's comment character, '#' by default.
SCISSORS = re.compile(r'^\S -{24} >8 -{24}$')


def message_text(raw):
    """The part of a commit message file that can become the message: all of it
    above the scissors line. Comment lines are KEPT: with `git commit -m` and the
    default cleanup, a line starting with '#' stays in the message."""
    lines = raw.splitlines()
    for i, line in enumerate(lines):
        if SCISSORS.match(line):
            return "\n".join(lines[:i])
    return raw


def name_lines(text, pattern):
    """1-based line numbers on which a roster name starts. The pattern joins a
    name's words on \\s+, so a name wrapped onto the next line still matches."""
    return sorted({text.count("\n", 0, m.start()) + 1 for m in pattern.finditer(text)})


def fields_naming(fields, pattern):
    """The LABELS of the (label, text) pairs whose text names someone on the
    roster, in order. Only labels come back: a caller's output lands in logs and
    chat, so it can say WHERE a name is without repeating it."""
    return [label for label, text in fields if text and pattern.search(text)]


def check_message_file(path):
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            raw = fh.read()
    except OSError as e:
        print(f"private-name guard: cannot read the commit message at {path}: {e.strerror}",
              file=sys.stderr)
        return 2
    pattern, missing = roster_pattern()
    if missing:
        print(f"⚠️  private-name guard: {missing}, so the commit message was NOT checked "
              "for private names. Restore the file to turn the guard back on.", file=sys.stderr)
        return 0
    lines = name_lines(message_text(raw), pattern)
    if not lines:
        return 0
    where = ("line " if len(lines) == 1 else "lines ") + ", ".join(
        str(n) for n in lines[:MAX_REPORTED])
    print("🛑 Commit refused: this repo is PUBLIC and the commit MESSAGE names a person on "
          f"the private roster ({where}).", file=sys.stderr)
    print("Reword the message without the name and commit again. Your staged changes are "
          "untouched.", file=sys.stderr)
    return 1


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Refuse a commit that names someone on the private roster.")
    parser.add_argument("--message-file", metavar="PATH",
                        help="check this commit message instead of the staged changes")
    args = parser.parse_args(argv)
    if args.message_file:
        return check_message_file(args.message_file)
    pattern, missing = roster_pattern()
    if missing:
        print(f"⚠️  private-name guard: {missing}, so private names were "
              "NOT checked. Restore the file to turn the guard back on.", file=sys.stderr)
        return 0
    hits = find_hits(staged_diff(), pattern)
    if not hits:
        return 0
    print("🛑 Commit refused: this repo is PUBLIC and the staged changes name a person on "
          "the private roster.", file=sys.stderr)
    for path, line_no in hits[:MAX_REPORTED]:
        print(f"   {path}:{line_no}", file=sys.stderr)
    if len(hits) > MAX_REPORTED:
        print(f"   ...and {len(hits) - MAX_REPORTED} more", file=sys.stderr)
    print("Move private working files to ~/Projects/kevin-hq, or replace the name with a "
          "fictional one (scripts/report_scrub.py), then unstage it and commit again.",
          file=sys.stderr)
    return 1


if __name__ == '__main__':
    sys.exit(main())
