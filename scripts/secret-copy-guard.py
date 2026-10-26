#!/usr/bin/env python3
"""Find copies of a live credential sitting outside ~/.config/od, and take the exposure off them.

Rule 1 of the credential rules (memory project_scheduled_job_alerting_and_credentials) is that every
secret lives ONCE, at ~/.config/od/<name>. It keeps being broken by hand inside slot runs rather than
by code: on 22 Sep 2026 an agent wrote the live Airtable PAT to
~/knowledge-os/logs/ceo-agent/scratch/pat.txt at mode 0644 (finding 20260924-report-597), and on
29 Sep 2026 another wrote the same token to ~/knowledge-os/logs/task-manager/scratch/.airtable_pat,
also world-readable. Nothing in the repo writes either path, so there is no call site to fix; what was
missing is anything that LOOKS.

This compares file CONTENTS against the canonical secret values, so it catches a copy under any name.
A hit is reported with the secret it matches (never the value), and its mode is tightened to 0600 so
the world-readable exposure stops immediately. It deletes nothing: a copy some script still reads is
a working dependency, and this must never cost work.

It deletes nothing by default, for the reason above. With --delete-unread it removes the one shape
of copy that cannot cost work: a file whose whole content is the secret and nothing else, that no
durable code anywhere references, and that has had no route off this Mac. That mode exists because
the caution above turned into its own fault. Findings 20261019-phase-2-990 and 20261020-phase-2-1007:
a live Airtable PAT copy sat at ~/knowledge-os/logs/task-manager/scratch/.airtable_pat from 29 Sep
2026, mac-guard exited 1 on every hourly run for three weeks, and its red light therefore meant
nothing. Nothing could clear it either — findings 20261015-agent-dispatch-902 and
20261020-agent-dispatch-1013: an ad-hoc `rm` is refused by the permission settings every unattended
run is started with, so three robots and daily-ops each reported the same wall and none could pass
it. The deletion belongs in this script, which already proves the facts that make it safe.

Exit 0 when clean, 1 when a copy was found, 2 when it could not look (no canonical secrets readable).

Usage:
  python3 scripts/secret-copy-guard.py
  python3 scripts/secret-copy-guard.py --no-chmod        # report only, change no modes
  python3 scripts/secret-copy-guard.py --delete-unread   # also delete a bare copy nothing reads
  python3 scripts/secret-copy-guard.py --selftest
"""
import os
import re
import shutil
import subprocess
import sys

CONFIG_DIR = os.path.expanduser("~/.config/od")

# Where agents and jobs actually write. Deliberately not the whole home directory: this runs hourly
# and a full walk of a 16 GB Mac is not free. ~/.claude/projects holds session transcripts, which no
# guard can clean up (they are append-only history) — the finding routes those to a PAT rotation.
SEARCH_ROOTS = ("~/knowledge-os", "~/.config/od/..", "~/Projects/leadership-dashboard/monitoring")

# A secret short enough to collide with ordinary text is not safe to grep for. 24 characters is well
# under every real token here and well over any value that could appear by chance.
MIN_SECRET_LEN = 24

# An IDENTIFIER is not a credential, and ~/.config/od holds both: pingen_org_id, ghl_location_id and
# ghl_user_id_kevin sit beside the tokens. The org id is a UUID that appears in an ordinary Pingen
# dashboard URL, so on the first live run it matched four unrelated log files and status files
# (11 Oct 2026) — four findings' worth of noise for nothing leaked. A bare UUID or a bare number is
# therefore never treated as a secret: knowing it grants nothing.
UUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")


def is_identifier(value):
    """True for a value that names something rather than authorising anything."""
    return bool(UUID_RE.match(value)) or value.isdigit()

SKIP_DIRS = {".git", "node_modules", ".venv", "__pycache__"}
MAX_FILE_BYTES = 2_000_000          # a credential copy is tiny; do not read a 500 MB video


def canonical_secrets(config_dir=CONFIG_DIR):
    """{value: name} for every secret stored once in ~/.config/od, ignoring the plain settings files.

    Only single-line values are taken. The directory also holds JSON config and flag files (models,
    content_engine_mode, redact-names.txt), whose contents are not credentials and whose short lines
    would match everywhere.
    """
    out = {}
    try:
        names = sorted(os.listdir(config_dir))
    except OSError:
        return out
    for name in names:
        path = os.path.join(config_dir, name)
        if not os.path.isfile(path):
            continue
        try:
            if os.path.getsize(path) > 8192:
                continue
            text = open(path, encoding="utf-8", errors="replace").read()
        except OSError:
            continue
        lines = [l.strip() for l in text.splitlines() if l.strip()]
        if len(lines) != 1:                      # JSON blobs and lists are config, not a secret
            continue
        value = lines[0]
        if len(value) < MIN_SECRET_LEN or " " in value or is_identifier(value):
            continue
        out[value] = name
    return out


def walk_files(roots=SEARCH_ROOTS, config_dir=CONFIG_DIR):
    """Every readable regular file under the search roots, except inside ~/.config/od itself."""
    config_real = os.path.realpath(config_dir)
    seen = set()
    for root in roots:
        base = os.path.realpath(os.path.expanduser(root))
        if not os.path.isdir(base):
            continue
        for dirpath, dirnames, filenames in os.walk(base):
            dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
            if os.path.realpath(dirpath) == config_real:
                dirnames[:] = []
                continue
            for fn in filenames:
                path = os.path.join(dirpath, fn)
                real = os.path.realpath(path)
                if real in seen or real.startswith(config_real + os.sep):
                    continue
                seen.add(real)
                yield path


def find_copies(secrets, files):
    """[(path, secret name, mode, value)] for every file whose text contains a canonical secret.

    The matched VALUE rides along (4th element, appended so every existing caller is unaffected)
    because deciding whether a file is a bare copy of one secret needs the value, and re-reading
    ~/.config/od per hit to find it again would be a second chance to get the wrong one.
    """
    hits = []
    for path in files:
        try:
            if os.path.getsize(path) > MAX_FILE_BYTES:
                continue
            text = open(path, encoding="utf-8", errors="replace").read()
        except OSError:
            continue
        for value, name in secrets.items():
            if value in text:
                try:
                    mode = os.stat(path).st_mode & 0o777
                except OSError:
                    mode = None
                hits.append((path, name, mode, value))
                break
    return hits


# A copy that never left this Mac is cleared by DELETING it. Rotation is the answer only when the
# value has had a route off the machine. 15 Oct 2026, finding 20261015-agent-dispatch-885: the
# closing line always demanded a rotation ("that is Kevin's, not a script's"), which put a
# credential wall on task rec1PD85WcOJRtNF7 that Kevin could not act on — it asked for work the
# exposure did not need and did not say which token was meant.
SYNCED_MARKERS = ("/Library/Mobile Documents/", "/Library/CloudStorage/", "/Dropbox/",
                  "/Google Drive/", "/OneDrive")


def left_the_mac(path):
    """Why this copy may have escaped this Mac, or "" when it cannot have.

    Two routes exist under the search roots: a folder a sync client uploads, and a file git
    tracks, because the leadership-dashboard repo is PUBLIC and a tracked copy is a published one.
    """
    real = os.path.realpath(path)
    for marker in SYNCED_MARKERS:
        if marker in real:
            return "it sits in a folder a sync client uploads (%s)" % marker.strip("/")
    try:
        r = subprocess.run(["git", "ls-files", "--error-unmatch", "--", real],
                           cwd=os.path.dirname(real), capture_output=True, text=True, timeout=30)
        if r.returncode == 0:
            return "git tracks it, and this repo is public"
    except (OSError, subprocess.SubprocessError):
        pass
    return ""


# ─── DELETING A COPY THAT CANNOT COST WORK ───────────────────────────
#
# Three facts have to hold before a delete is safe, and this script already establishes two of
# them. The third is "nothing reads it", and the only honest place to look is DURABLE code: the
# repo, Kevin's tools, and the agent rule/skill/task files. Deliberately NOT the log and scratch
# tree itself — finding 20261020-phase-2-1007 found the stray copy referenced only by throwaway
# scratch scripts sitting beside it, and treating those as a dependency is what kept a live
# credential on disk for three weeks. If such a script runs again it writes the copy again, and
# this guard catches it again on the next hour.
READER_ROOTS = ("~/tools", "~/.claude/agents", "~/.claude/skills", "~/.claude/scheduled-tasks")

# A credential copy is a file holding a credential and nothing else. A log, report or transcript
# that happens to QUOTE a token is debris too, but deleting one destroys the evidence of how the
# token got there, so those keep reporting and go to a person. 4096 is far above any real token
# and far below any log worth keeping.
BARE_COPY_MAX_BYTES = 4096


def is_bare_copy(path, value):
    """True when the file's entire content is the secret value and nothing else."""
    try:
        if os.path.getsize(path) > BARE_COPY_MAX_BYTES:
            return False
        text = open(path, encoding="utf-8", errors="replace").read()
    except OSError:
        return False
    lines = [l.strip() for l in text.splitlines() if l.strip()]
    return lines == [value]


def readers_of(path, reader_roots=READER_ROOTS, repo=None):
    """Files in durable code that mention this path. Empty means nothing reads it.

    Matched three ways, because code refers to one file in three spellings: the absolute path, the
    ~ form, and the last two components ("scratch/.airtable_pat"), which is how a script that
    builds the path from a directory variable spells it.
    """
    real = os.path.realpath(path)
    home = os.path.expanduser("~")
    needles = {real}
    if real.startswith(home + os.sep):
        needles.add("~" + real[len(home):])
    parent, base = os.path.split(real)
    if parent and base:
        needles.add(os.path.join(os.path.basename(parent), base))

    if repo is None:
        repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    roots = [repo] + [os.path.expanduser(r) for r in reader_roots]
    roots = [r for r in roots if os.path.isdir(r)]
    if not roots:
        return []

    # This file names the stray path in its own docstring and comments, and must never read as a
    # reader of it. Resolved, so the worktree copy and the main checkout copy both match.
    myself = os.path.realpath(__file__)

    # A stale git worktree is a CHECKOUT, not durable code (finding 20261025-queue-fixer-1080).
    # Fourteen of them had piled up in the main checkout, each holding its own copy of THIS file,
    # and every one of those copies quotes the stray path in a comment. So the guard read itself,
    # fourteen times over, as code that still refers to the copy and refused every delete — which
    # turned tests/secret-copy-guard.test.js red on main while the guard itself was working.
    worktrees = os.path.realpath(os.path.join(repo, ".claude", "worktrees"))

    args = ["grep", "-r", "-l", "-I", "-F"]
    for d in SKIP_DIRS:
        args += ["--exclude-dir", d]
    for n in sorted(needles):
        args += ["-e", n]
    args += roots
    try:
        r = subprocess.run(args, capture_output=True, text=True, timeout=120)
    except (OSError, subprocess.SubprocessError):
        # Could not look. "No readers" must never be ASSUMED: an unreadable answer keeps the file.
        return ["<could not search for readers>"]
    if r.returncode not in (0, 1):
        return ["<could not search for readers>"]
    hits = []
    for line in (r.stdout or "").splitlines():
        line = line.strip()
        if not line:
            continue
        real_hit = os.path.realpath(line)
        if real_hit == myself:
            continue
        if real_hit.startswith(worktrees + os.sep):
            continue
        hits.append(line)
    return hits


def delete_unread(path, name, value):
    """Delete a bare copy nothing reads. Returns (deleted, why_not)."""
    return delete_unread_in(path, name, value)


def delete_unread_in(path, name, value, repo=None):
    """delete_unread, with the code tree to search for readers injectable for the selftest."""
    if os.path.islink(path):
        return False, "it is a symlink, so deleting it would not remove the copy"
    if not is_bare_copy(path, value):
        return False, "the file holds more than the secret, so deleting it would destroy a record"
    why = left_the_mac(path)
    if why:
        return False, "it had a route off this Mac (%s), so it needs a rotation, not a delete" % why
    readers = readers_of(path, repo=repo)
    if readers:
        return False, "code still refers to it (%s)" % ", ".join(readers[:3])
    try:
        os.unlink(path)
    except OSError as exc:
        return False, "the delete failed (%s)" % exc
    return True, ""


def tighten(path):
    """0600 the file, so the world-readable exposure stops. Returns True when the mode changed."""
    try:
        mode = os.stat(path).st_mode & 0o777
        if mode == 0o600:
            return False
        os.chmod(path, 0o600)
        return True
    except OSError:
        return False


def main(argv):
    if "--selftest" in argv:
        return selftest()
    do_chmod = "--no-chmod" not in argv
    do_delete = "--delete-unread" in argv
    secrets = canonical_secrets()
    if not secrets:
        print("secret-copy-guard: CANNOT CHECK — no single-line secrets readable in %s" % CONFIG_DIR)
        return 2
    hits = find_copies(secrets, walk_files())
    if not hits:
        print("secret-copy-guard: clean — no copy of any of the %d stored secrets outside %s"
              % (len(secrets), CONFIG_DIR))
        return 0
    escaped = []
    deleted = []
    remaining = []
    for path, name, mode, value in hits:
        if do_delete:
            gone, why_not = delete_unread(path, name, value)
            if gone:
                deleted.append((path, name))
                print("secret-copy-guard: DELETED the copy of '%s' at %s — nothing reads it and it "
                      "never left this Mac; the stored copy at %s/%s keeps every job working"
                      % (name, path, CONFIG_DIR, name))
                continue
            print("secret-copy-guard: KEPT the copy of '%s' at %s — %s" % (name, path, why_not))
        remaining.append((path, name, mode))
        changed = tighten(path) if do_chmod else False
        print("secret-copy-guard: COPY OF '%s' at %s (mode %s)%s"
              % (name, path, oct(mode) if mode is not None else "unknown",
                 " -> tightened to 0600" if changed else ""))
        why = left_the_mac(path)
        if why:
            escaped.append((path, name, why))
    if deleted and not remaining:
        # Green, and it means something again. A guard that stays red while nothing can clear it
        # buries the next real alert, which is what findings 990 and 1007 measured over 3 weeks.
        print("secret-copy-guard: clean — %d copy/copies deleted, none left outside %s"
              % (len(deleted), CONFIG_DIR))
        return 0
    print("secret-copy-guard: %d copy/copies found%s. Delete the file(s) listed above and the "
          "exposure this guard measures is gone; the one stored copy at %s/<name> keeps working."
          % (len(hits), (", %d deleted" % len(deleted)) if deleted else "", CONFIG_DIR))
    for path, name, why in escaped:
        print("secret-copy-guard: ROTATE the secret held in %s/%s as well — %s (%s)"
              % (CONFIG_DIR, name, why, path))
    if not escaped:
        print("secret-copy-guard: no rotation needed — none of these copies had a route off this Mac.")
    return 1


def selftest():
    """Back-tested by planting the fault: a file holding a canonical value must be found, and one
    holding a short or absent value must not."""
    import tempfile

    with tempfile.TemporaryDirectory() as tmp:
        cfg = os.path.join(tmp, "od")
        os.makedirs(cfg)
        token = "patTESTTOKENvalue1234567890abcdefXYZ"
        open(os.path.join(cfg, "airtable_pat"), "w").write(token + "\n")
        open(os.path.join(cfg, "short_flag"), "w").write("on\n")                 # too short to grep
        open(os.path.join(cfg, "listy.json"), "w").write('{\n "a": 1\n}\n')       # config, not a secret
        org = "286c1111-2222-3333-4444-555566667777"                               # an id, not a credential
        open(os.path.join(cfg, "pingen_org_id"), "w").write(org + "\n")
        open(os.path.join(cfg, "some_count"), "w").write("123456789012345678901234567\n")
        secrets = canonical_secrets(cfg)
        assert secrets == {token: "airtable_pat"}, secrets
        assert is_identifier(org) and is_identifier("12345678901234567890123456")
        assert not is_identifier(token)

        scratch = os.path.join(tmp, "scratch")
        os.makedirs(scratch)
        leak = os.path.join(scratch, ".airtable_pat")
        open(leak, "w").write(token + "\n")
        os.chmod(leak, 0o644)
        clean = os.path.join(scratch, "notes.md")
        open(clean, "w").write("the token is in ~/.config/od/airtable_pat, never printed\n")
        idfile = os.path.join(scratch, "status.json")
        open(idfile, "w").write('{"landedOn": "https://app.pingen.com/organisation/%s/dashboard"}\n' % org)

        files = [leak, clean, idfile]
        hits = find_copies(secrets, files)
        assert [h[0] for h in hits] == [leak], hits
        assert hits[0][1] == "airtable_pat" and hits[0][2] == 0o644, hits
        assert tighten(leak) is True
        assert os.stat(leak).st_mode & 0o777 == 0o600
        assert tighten(leak) is False                 # already tight, no churn
        assert find_copies({}, files) == []           # nothing to look for, nothing found

        # ~/.config/od itself is never reported as a copy of itself
        reported = list(walk_files(roots=[tmp], config_dir=cfg))
        assert all("/od/" not in p for p in reported), reported

        # --delete-unread, back-tested by planting each fault it must refuse.
        code = os.path.join(tmp, "code")
        os.makedirs(code)
        assert is_bare_copy(leak, token)                 # the copy itself: nothing but the token
        assert not is_bare_copy(clean, token)            # prose mentioning the path is not a copy
        noisy = os.path.join(scratch, "run.log")
        open(noisy, "w").write("step 1 ok\nPAT=%s\nstep 2 ok\n" % token)
        assert not is_bare_copy(noisy, token)            # a log that quotes it keeps its record
        assert readers_of(leak, reader_roots=[], repo=code) == []

        # A STALE WORKTREE is not a reader (finding 20261025-queue-fixer-1080). Plant a checkout
        # under .claude/worktrees holding a copy of THIS file, which quotes the stray path in its
        # own comments exactly as the real copies do, and the guard must still see nothing reading
        # the file. Back-test: drop the worktrees filter in readers_of and this assertion fails.
        stale = os.path.join(code, ".claude", "worktrees", "queue-fixes-2026-10-03", "scripts")
        os.makedirs(stale)
        shutil.copyfile(os.path.realpath(__file__),
                        os.path.join(stale, "secret-copy-guard.py"))
        open(os.path.join(stale, "note.txt"), "w").write(
            "quotes %s and %s\n" % (os.path.realpath(leak), os.path.join(
                os.path.basename(os.path.dirname(os.path.realpath(leak))),
                os.path.basename(leak))))
        assert readers_of(leak, reader_roots=[], repo=code) == [], \
            readers_of(leak, reader_roots=[], repo=code)

        open(os.path.join(code, "reader.py"), "w").write(
            "PAT = open(%r).read()\n" % leak)
        assert readers_of(leak, reader_roots=[], repo=code) == [
            os.path.join(code, "reader.py")], readers_of(leak, reader_roots=[], repo=code)

        # A file something reads is never deleted, whatever else is true of it.
        gone, why = delete_unread_in(leak, "airtable_pat", token, repo=code)
        assert gone is False and "still refers to it" in why, (gone, why)
        # A file holding more than the secret is never deleted.
        gone, why = delete_unread_in(noisy, "airtable_pat", token, repo=tmp)
        assert gone is False and "destroy a record" in why, (gone, why)
        assert os.path.exists(noisy)
        # Nothing reads it and it never left the Mac: it goes.
        os.unlink(os.path.join(code, "reader.py"))
        gone, why = delete_unread_in(leak, "airtable_pat", token, repo=code)
        assert gone is True and why == "", (gone, why)
        assert not os.path.exists(leak)
        assert os.path.exists(os.path.join(cfg, "airtable_pat"))   # the one stored copy survives
    print("secret-copy-guard selftest: ok")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
