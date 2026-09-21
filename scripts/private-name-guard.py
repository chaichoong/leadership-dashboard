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
"""

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


def main():
    names = load_roster()
    if not names:
        print(f"⚠️  private-name guard: no roster at {roster_path()}, so private names were "
              "NOT checked. Restore the file to turn the guard back on.", file=sys.stderr)
        return 0
    hits = find_hits(staged_diff(), compile_names(names))
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
