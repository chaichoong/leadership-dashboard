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

Exit 0 when clean, 1 when a copy was found, 2 when it could not look (no canonical secrets readable).

Usage:
  python3 scripts/secret-copy-guard.py
  python3 scripts/secret-copy-guard.py --no-chmod   # report only, change no modes
  python3 scripts/secret-copy-guard.py --selftest
"""
import os
import re
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
    """[(path, secret name, mode)] for every file whose text contains a canonical secret value."""
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
                hits.append((path, name, mode))
                break
    return hits


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
    secrets = canonical_secrets()
    if not secrets:
        print("secret-copy-guard: CANNOT CHECK — no single-line secrets readable in %s" % CONFIG_DIR)
        return 2
    hits = find_copies(secrets, walk_files())
    if not hits:
        print("secret-copy-guard: clean — no copy of any of the %d stored secrets outside %s"
              % (len(secrets), CONFIG_DIR))
        return 0
    for path, name, mode in hits:
        changed = tighten(path) if do_chmod else False
        print("secret-copy-guard: COPY OF '%s' at %s (mode %s)%s"
              % (name, path, oct(mode) if mode is not None else "unknown",
                 " -> tightened to 0600" if changed else ""))
    print("secret-copy-guard: %d copy/copies found. The value is live, so it is only safe once the "
          "secret is rotated: that is Kevin's, not a script's." % len(hits))
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
    print("secret-copy-guard selftest: ok")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
