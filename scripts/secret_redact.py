#!/usr/bin/env python3
"""Take secret-shaped strings out of text before it is written anywhere durable.

Why (finding 20261010-phase-5-822): on 1 Oct 2026 Kevin pasted a live Anthropic user API key into
a card's "changes requested" box — the task was literally "replace Karlo's CLAUDE_AI_KEY secret" —
and agent-dispatch archived his words verbatim into the task's Notes. The key then sat in plain
text in an OPEN Airtable record for nine days, readable by everyone the base is shared with. The
same box had carried a live Airtable PAT before (finding 20260824-agent-dispatch-337 wording).

The carrier is the fix, not the person. A credential pasted into a feedback box is a mistake
someone will always make, so the write path refuses to store it rather than asking them not to.

Rules this follows:
  - Replace, never drop. The reader must see that a secret was there, so the shape and the
    placeholder stay: "sk-ant-api03-REDACTED". Silently deleting it makes a note read as if the
    instruction never mentioned a key.
  - Never log, print or return the value. The only output is the redacted text.
  - Match on the token's own prefix, not on the words near it. "the key is X" and "X" must both
    be caught, and a heading like "API key:" with nothing after it must not be.

Usage:
    from secret_redact import redact_secrets
    safe = redact_secrets(text)
"""
import re
import sys

PLACEHOLDER = "REDACTED"

# Each pattern keeps its recognisable prefix in the replacement so a reader can tell WHICH kind of
# credential was pasted, which is what makes the note actionable ("rotate the Anthropic key").
#
# Lengths are minimums taken from the real things: an Anthropic key is ~100 chars after the
# prefix, an Airtable PAT ~70, a GitHub token 36+. The minimums are set well below those and well
# above anything that occurs in prose, so "sk-ant-" written as a bare example is left alone.
PATTERNS = (
    # Anthropic: sk-ant-api03-..., sk-ant-admin01-..., and the older sk-ant-...
    (re.compile(r"\bsk-ant-(?:[A-Za-z0-9]+-)?[A-Za-z0-9_\-]{24,}"), lambda m: "sk-ant-" + PLACEHOLDER),
    # Airtable personal access token / legacy key
    (re.compile(r"\bpat[A-Za-z0-9]{10,}\.[A-Za-z0-9]{20,}"), lambda m: "pat" + PLACEHOLDER),
    (re.compile(r"\bkey[A-Za-z0-9]{14,}\b"), lambda m: "key" + PLACEHOLDER),
    # GitHub
    (re.compile(r"\b(gh[pousr]_)[A-Za-z0-9]{30,}"), lambda m: m.group(1) + PLACEHOLDER),
    # OpenAI and the generic sk- family, AFTER sk-ant- so the more specific label wins
    (re.compile(r"\bsk-(?!ant-)[A-Za-z0-9_\-]{24,}"), lambda m: "sk-" + PLACEHOLDER),
    # Slack
    (re.compile(r"\bxox[abprs]-[A-Za-z0-9\-]{16,}"), lambda m: "xox-" + PLACEHOLDER),
    # Google / Stripe
    (re.compile(r"\bAIza[A-Za-z0-9_\-]{30,}"), lambda m: "AIza" + PLACEHOLDER),
    (re.compile(r"\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{20,}"), lambda m: m.group(1) + "_" + m.group(2) + "_" + PLACEHOLDER),
    # A bearer token handed over in a header line. The scheme word stays so the line still reads.
    (re.compile(r"\b(Bearer|Authorization:\s*Bearer)\s+[A-Za-z0-9_\-\.=]{24,}"), lambda m: m.group(1) + " " + PLACEHOLDER),
    # A private key block, however long
    (re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----", re.S),
     lambda m: "-----BEGIN PRIVATE KEY----- " + PLACEHOLDER + " -----END PRIVATE KEY-----"),
)


def redact_secrets(text):
    """`text` with every secret-shaped string replaced by its prefix plus REDACTED.

    Non-string input is returned untouched, so this is safe to wrap around a value that may be
    None or already a number. Idempotent: redacting twice changes nothing.
    """
    if not isinstance(text, str) or not text:
        return text
    out = text
    for pattern, repl in PATTERNS:
        out = pattern.sub(repl, out)
    return out


def holds_secret(text):
    """True when redact_secrets would change `text`. For a guard that wants to refuse, not rewrite."""
    return isinstance(text, str) and bool(text) and redact_secrets(text) != text


def selftest():
    """Back-tested by planting the real shapes. Every case here is a string that reached, or could
    reach, a durable field."""
    # the actual incident: his feedback named the key and pasted it
    key = "sk-ant-api03-" + "A1b2C3d4E5" * 10
    note = "Replace Karlo's CLAUDE_AI_KEY secret. The new key is %s — use that one." % key
    safe = redact_secrets(note)
    assert key not in safe, safe
    assert "sk-ant-REDACTED" in safe, safe
    assert safe.startswith("Replace Karlo's CLAUDE_AI_KEY secret."), safe
    assert redact_secrets(safe) == safe                      # idempotent

    pat = "patAbCdEfGhIjKl.1234567890abcdefghijklmnopqrstuvwxyz0123456789"
    assert pat not in redact_secrets("PAT: " + pat)
    assert "patREDACTED" in redact_secrets("PAT: " + pat)

    gh = "ghp_" + "x" * 36
    assert gh not in redact_secrets("token " + gh)
    assert "ghp_REDACTED" in redact_secrets("token " + gh)

    bearer = "Authorization: Bearer " + "y" * 40
    assert "y" * 40 not in redact_secrets(bearer)
    assert "Bearer REDACTED" in redact_secrets(bearer)

    sk = "sk-" + "z" * 40
    assert sk not in redact_secrets("openai " + sk)
    assert "sk-REDACTED" in redact_secrets("openai " + sk)

    blob = "-----BEGIN RSA PRIVATE KEY-----\nMIIsecret\nmore\n-----END RSA PRIVATE KEY-----"
    assert "MIIsecret" not in redact_secrets(blob)

    # Prose that merely TALKS about keys must survive word for word. A note Kevin cannot read is
    # a different failure, not a smaller one.
    for plain in (
        "Rotate the sk-ant- key in the Anthropic console, then tell me.",
        "The API key is in ~/.config/od/airtable_pat, never printed.",
        "Her key fob needs replacing at 12 Dalham Road.",
        "Bearer token missing from the header, add one.",
        "keyword search found nothing",
        "",
    ):
        assert redact_secrets(plain) == plain, plain
        assert not holds_secret(plain), plain

    assert holds_secret(note)
    assert redact_secrets(None) is None
    assert redact_secrets(7) == 7
    print("secret_redact selftest: ok")
    return 0


if __name__ == "__main__":
    sys.exit(selftest() if "--selftest" in sys.argv[1:] else selftest())
