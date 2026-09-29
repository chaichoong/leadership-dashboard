"""What counts as a live note in the brain vault: ONE copy of the rule.

29 Sep 2026. After the estate moved to the Mac mini, Google Drive rebuilt its
local database (27 Sep 12:03 UTC) and macOS renamed one of each same-name cloud
pair to "<name> 2.md": 89 files, all moved by hand into
Archive/2026-09-29 sync duplicates/ (MOVED.txt there lists them). Every reader
that globbed the vault would otherwise have indexed them as notes, counted a
twin in Decisions/ as a second ruling, and indexed the Archive copies as well.

A TWIN is a file "<stem> <N>.md" whose sibling "<stem>.md" exists in the same
folder, N being 2 to 99: macOS numbers copies from 2, and a longer ending is a
year or a quantity ("Tax return 2026.md" beside "Tax return.md" is a note). The
name alone is not enough: real notes end in a digit, e.g. "Decisions/2026-08-24
No caps on agent work, and the triage lane runs at 9, 1 and 5.md", which has no
"... at 9, 1 and.md" beside it.

ARCHIVE is the vault's top-level Archive/ folder: the record of what was moved
out of the live vault, never live knowledge.

Readers: ~/knowledge-os/publish_brain_today.py (loads this file from the main
checkout), scripts/agent-estate-drift.py, and the twins half of
scripts/drive-auth-check.py, which is the daily alarm if twins come back.
"""
import os
import re

ARCHIVE = "Archive"
_N = r"(?:[2-9]|[1-9][0-9])"
_TWIN = re.compile(r"^(?P<stem>.+) " + _N + r"\.md$")
_TWIN_DIR = re.compile(r"^(?P<stem>.+) " + _N + r"$")


def twin_original(path):
    """The "<stem>.md" this file duplicates, or None when it is not a twin."""
    m = _TWIN.match(os.path.basename(path))
    if not m:
        return None
    original = os.path.join(os.path.dirname(path), m.group("stem") + ".md")
    return original if os.path.isfile(original) else None


def is_twin(path):
    return twin_original(path) is not None


def is_archived(rel):
    """True for a path, relative to the vault root, inside the top-level Archive/."""
    return rel.startswith(ARCHIVE + os.sep)


def find_twins(vault):
    """Every twin in the live vault, Archive/ left out.

    Returns (twins, scanned, errors): twin paths relative to the vault, sorted;
    how many .md files the walk looked at; and every folder it could not list.
    os.walk drops a listing error silently unless it is handed onerror, and a
    folder it could not list is one it could not check, so the errors come back
    to the caller rather than reading as "no twins there".

    The alarm also names a twin FOLDER ("Knowledge 2/" beside "Knowledge/",
    reported with a trailing separator) and does not walk into it: the readers
    skip twin files only, so a duplicated folder must be seen by a person.
    """
    vault = os.fspath(vault)
    twins, errors, scanned = [], [], 0
    for root, dirs, files in os.walk(vault, onerror=errors.append):
        if root == vault:
            dirs[:] = [d for d in dirs if d != ARCHIVE]
        for d in list(dirs):
            m = _TWIN_DIR.match(d)
            if m and os.path.isdir(os.path.join(root, m.group("stem"))):
                twins.append(os.path.relpath(os.path.join(root, d), vault) + os.sep)
                dirs.remove(d)
        for f in files:
            if not f.endswith(".md"):
                continue
            scanned += 1
            path = os.path.join(root, f)
            if is_twin(path):
                twins.append(os.path.relpath(path, vault))
    return sorted(twins), scanned, errors
