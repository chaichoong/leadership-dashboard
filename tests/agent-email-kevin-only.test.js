// What is written for Kevin never reaches the recipient (7 Oct 2026, finding 20261007-agent-dispatch-780).
//
// WHY. The send path stripped the TRACK RECORD header and its DATED bullets, and nothing else.
//   - From 27 Aug to 23 Sep, nine emails to outside recipients carried agent notes written under a
//     SECOND "---" line below the signature ("AGENT NOTES (not for sending)", legal notes marked
//     "not for sending", a tier-1 banner, a creditor matter's position summary).
//   - On 7 Oct a TRACK RECORD block under the signature went out with its undated lines and the
//     paragraph after it.
//   - On 15 Sep a reply opened with the report gate's CHECKED line.
// The shapes below are those, with every name, place and figure invented (this repo is public).
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = resolve(ROOT, 'scripts');

function parse(output) {
  const py = `
import json, sys
sys.path.insert(0, ${JSON.stringify(SCRIPTS)})
from agent_email_format import parse_output, EmailFormatError
try:
    print(json.dumps({"ok": True, "mail": parse_output(sys.argv[1])}))
except EmailFormatError as e:
    print(json.dumps({"ok": False, "error": str(e)}))
`;
  return JSON.parse(execFileSync('python3', ['-c', py, output], { encoding: 'utf8' }).trim());
}

const HEAD = 'TO: office@example-alarms.test\nFROM: info@example-lets.test\nSUBJECT: Example House: certificates\n---\n';
const EMAIL = 'Hi Sam,\n\nPlease send the fire alarm certificate for Example House.\n\n- the 2026 service report\n- the emergency lighting test\n\nKind regards\nAlex Example\nExample Lets';
const CARRY = '\n\n**Carrying this out will involve:** sending this email to office@example-alarms.test.';

describe('a TRACK RECORD block in the body', () => {
  it('below the email is refused, never cut and never sent: its undated lines leaked on 7 Oct', () => {
    const r = parse(HEAD + EMAIL + '\n\nTRACK RECORD: (searched the book and both mailboxes)\n'
      + '- 3 Mar 2026: the contractor sent the 2025 report.\n- Compliance book: the lighting ran to 22 Apr 2026.\n'
      + '- Bank check: no paid visit without a certificate.\n\nWhen the certificates arrive: each is filed with its date.' + CARRY);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/TRACK RECORD sits inside the email/);
  });

  it('in the middle of the email is refused: a cut would send a stub of what Kevin approved (review, 8 Oct)', () => {
    const r = parse(HEAD + 'Hi Sam,\n\nTRACK RECORD: (searched)\n- 03 Oct 2026 — email: Sam: the report\n\nThanks for the report. We pay Friday.\n\nKind regards\nAlex' + CARRY);
    expect(r.ok).toBe(false);
  });

  it('decorated (**TRACK RECORD:** or a [stamp] before it) is still a track record', () => {
    for (const head of ['**TRACK RECORD:** (searched)', '[07 Oct 2026 — agent] TRACK RECORD: (searched)']) {
      const r = parse(HEAD + EMAIL + '\n\n' + head + '\n- Compliance book: notes.' + CARRY);
      expect(r.ok, head).toBe(false);
    }
  });

  it('at the top of the body, with the report gate line above it, both go and the email stays whole', () => {
    const r = parse(HEAD + 'CHECKED: handled=no; roy=no; machine=no; open-task=no; trigger=unknown-sender\n\n'
      + 'TRACK RECORD: (searched tasks + Gmail)\n- 14 Sep 2026 12:37 — email: Sam Example: first message\n- No reply sent yet.\n  wrapped onto a second line\n\n'
      + EMAIL + CARRY);
    expect(r.ok).toBe(true);
    expect(r.mail.body.trim()).toBe(EMAIL);
  });

  it("at the top of the body, the email's own opening bullets after the blank line stay (review, 8 Oct)", () => {
    const own = '- Rent: 500 received on 1 Oct.\n- Deposit: protected.\n\nKind regards\nAlex';
    const r = parse(HEAD + 'TRACK RECORD: (searched)\n- 2 Oct 2026 — email: Sam: asked\n\n' + own + CARRY);
    expect(r.ok).toBe(true);
    expect(r.mail.body.trim()).toBe(own);
  });

  it('the report gate CHECKED line is never in an email, wherever it sits and whatever its key order', () => {
    for (const line of ['CHECKED: handled=no; roy=no; machine=no; open-task=no; trigger=legal',
                        'CHECKED: roy=no; handled=no; machine=no; open-task=no; trigger=legal']) {
      const r = parse(HEAD + EMAIL + '\n\n' + line + CARRY);
      expect(r.ok, line).toBe(true);
      expect(r.mail.body).not.toContain('CHECKED:');
      expect(r.mail.body.trim()).toBe(EMAIL);
    }
  });
});

describe('notes for Kevin under a second --- line', () => {
  it('are refused, never sent and never guessed', () => {
    const r = parse(HEAD + EMAIL + '\n\n---\n\nAGENT NOTES (not for sending):\n\nClassification: a creditor. Step two only if they refuse.' + CARRY);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/second separator line/);
  });

  it('also with Windows line endings, or a *** or ___ separator (review, 8 Oct)', () => {
    const notes = '\n\nAGENT NOTES:\n\nStep two only if they refuse.';
    for (const shape of [(HEAD + EMAIL + '\n\n---' + notes).replace(/\n/g, '\r\n'),
                         HEAD + EMAIL + '\n\n***' + notes, HEAD + EMAIL + '\n\n___' + notes,
                         HEAD + 'Hi Sam,\n\n---EMAIL---\n\n' + EMAIL]) {
      expect(parse(shape + CARRY).ok).toBe(false);
    }
  });

  it('a notes heading with no separator at all is refused ("not for sending", "for Kevin only")', () => {
    for (const h of ['**AGENT NOTES (not for sending):**', 'LEGAL & COMPLIANCE NOTES (Example Head — not for sending):',
                     "AGENT NOTE (not part of the email — for Kevin's review):", 'Note for Kevin only: check the deadline.']) {
      const r = parse(HEAD + EMAIL + '\n\n' + h + '\n\nClassification: a creditor.' + CARRY);
      expect(r.ok, h).toBe(false);
    }
  });

  it('a tier-1 banner left inside the email is refused, bold or not', () => {
    expect(parse(HEAD + EMAIL + '\n\n**TIER 1 [!] CREDITOR MATTER**' + CARRY).ok).toBe(false);
  });

  it('a tier-1 banner left inside the email is refused (the 23 Sep shape)', () => {
    const r = parse(HEAD + EMAIL + '\n\nTIER 1 [!] CREDITOR MATTER - APPROVE BEFORE ANYTHING IS SENT' + CARRY);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/tier-1 banner/);
  });
});

describe('the shapes that were already right stay right', () => {
  it('a TRACK RECORD above the headers is stripped and the body is untouched', () => {
    const r = parse('TRACK RECORD: (searched tasks)\n- 2 Oct 2026 — email: Sam Example: asked for the report\n\n' + HEAD + EMAIL + CARRY);
    expect(r.ok).toBe(true);
    expect(r.mail.body.trim()).toBe(EMAIL);
    expect(r.mail.to).toEqual(['office@example-alarms.test']);
  });

  it('a --- inside a dated line above the headers never moves the split (review, 8 Oct)', () => {
    const r = parse('TRACK RECORD: (searched)\n- 2 Oct 2026 — email: Sam: re --- the old report\n\n' + HEAD
      + 'TRACK RECORD: (and again)\n- 3 Oct 2026 — email: Sam: thanks\n\n' + EMAIL + CARRY);
    expect(r.ok).toBe(true);
    expect(r.mail.body.trim()).toBe(EMAIL);
  });

  it('an email that mentions a track record or a check in passing is untouched', () => {
    const body = 'Hi Sam,\n\nWe checked: handled by the agent last week. Our track record: three visits.\nTier 1 support covers the alarm panel.\n\nKind regards\nAlex';
    const r = parse(HEAD + body + CARRY);
    expect(r.ok).toBe(true);
    expect(r.mail.body.trim()).toBe(body);
  });
});
