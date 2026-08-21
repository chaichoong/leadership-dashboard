// The carry-out line must never reach the recipient.
//
// WHY (20 Aug 2026, finding 20260820-agent-dispatch-262)
// Every Agent Output has to END with "**Carrying this out will involve:** ..."
// — agent-dispatch.py refuses a submit without one, because Kevin's approval
// box leads with that line. It is a note to HIM about what approving does.
//
// On a Correspondence output it sits after the `---`, which means it is part of
// the email BODY. Nothing removed it, so every approved email would have been
// sent with a closing sentence telling the recipient that an AI agent was
// waiting on approval to send it. agent-dispatch's own SKILL.md already told
// agents the send path stripped it. The send path did not.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = resolve(ROOT, 'scripts');

// Exercise the real parser rather than re-implementing it in JS.
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

const HEAD = 'TO: clerk@fylde.gov.uk\nSUBJECT: Council tax on 12 Duckworth\n---\n';

describe('carry-out line stripping', () => {
  it('never leaves the marker in a parsed body', () => {
    const r = parse(HEAD + 'Dear Sir,\n\nPlease see attached.\n\nKind regards\nKevin\n\n' +
      '**Carrying this out will involve:** sends this email to the council and files a copy.');
    expect(r.ok).toBe(true);
    expect(r.mail.body).not.toMatch(/carrying this out will involve/i);
    expect(r.mail.body).not.toMatch(/files a copy/);
    expect(r.mail.body.trimEnd().endsWith('Kevin')).toBe(true);
  });

  it('strips it whatever markup wraps it', () => {
    for (const line of [
      '**Carrying this out will involve:** sends it.',
      'Carrying this out will involve: sends it.',
      '- **Carrying this out will involve:** sends it.',
      '**Carrying this out will involve** sends it.',
    ]) {
      const r = parse(HEAD + 'Body text here.\n\n' + line);
      expect(r.ok, line).toBe(true);
      expect(r.mail.body, line).toBe('Body text here.');
    }
  });

  it('takes the LAST occurrence, so a body discussing the phrase keeps its text', () => {
    const r = parse(HEAD +
      'We agreed that carrying this out will involve a site visit.\n\n' +
      'Kind regards\n\n**Carrying this out will involve:** sends this email.');
    expect(r.ok).toBe(true);
    expect(r.mail.body).toContain('a site visit');
    expect(r.mail.body).not.toContain('sends this email');
  });

  it('refuses an output whose body is nothing but the carry-out line', () => {
    // There is no email left to send, so this must fail loudly rather than
    // send a blank message to a real recipient.
    const r = parse(HEAD + '**Carrying this out will involve:** sends this email.');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/empty body/);
  });

  it('leaves an output with no carry-out line untouched', () => {
    const r = parse(HEAD + 'Dear Sir,\n\nJust the letter.\n\nKevin');
    expect(r.ok).toBe(true);
    expect(r.mail.body).toBe('Dear Sir,\n\nJust the letter.\n\nKevin');
  });

  it('strips the tier-1 banner and the carry-out line together', () => {
    const banner = execFileSync('python3', ['-c',
      `import sys; sys.path.insert(0, ${JSON.stringify(SCRIPTS)});` +
      'from agent_email_format import TIER1_BANNER; print(TIER1_BANNER)'],
      { encoding: 'utf8' }).trim();
    const r = parse(banner + '\n\n' + HEAD + 'The letter.\n\n' +
      '**Carrying this out will involve:** sends it.');
    expect(r.ok).toBe(true);
    expect(r.mail.body).toBe('The letter.');
    expect(r.mail.subject).toBe('Council tax on 12 Duckworth');
  });

  it('agent-dispatch imports the pattern rather than keeping its own copy', () => {
    // One pattern: what submit DEMANDS and what the send path STRIPS cannot drift.
    const src = execFileSync('cat', [resolve(SCRIPTS, 'agent-dispatch.py')], { encoding: 'utf8' });
    expect(src).toMatch(/from agent_email_format import[\s\S]{0,200}CARRY_OUT_RE/);
    expect(src).not.toMatch(/^CARRY_OUT_RE\s*=\s*re\.compile/m);
  });
});
