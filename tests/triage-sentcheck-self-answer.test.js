import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TRIAGE = resolve(ROOT, 'scripts/inbound-triage.py');
const RUNNER = readFileSync(resolve(ROOT, 'scripts/inbound-triage-run.sh'), 'utf8');
const SRC = readFileSync(TRIAGE, 'utf8');

// ─── FINDING 20260904-daily-ops-454 ──────────────────────────────────
//
// Scanned post produced ZERO tasks for 17 days and nothing errored anywhere.
// The post manager emails Kevin FROM Kevin. Gmail files that as ONE message
// carrying a SENT label and no INBOX label, with id === threadId because it is
// the only message on the thread. The sent-check recorded "this thread has a
// send", the triage agent read "already answered", and a Companies House
// strike-off notice, a council tax summons and an HMRC compliance check were
// all filed in silence.
//
// Back-tested READ-ONLY against the live mailbox on 8 Sep 2026, `in:sent
// newer_than:20d`: 49 sent messages, of which 28 were self-addressed POST
// scans. The old map reported 46 answered threads; the correct one reports 18.
// Every one of those 28 was suppressing its own task.

function py(snippet) {
  const script = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('t', ${JSON.stringify(TRIAGE)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
${snippet}
`;
  return JSON.parse(execFileSync('python3', ['-c', script], { encoding: 'utf8' }));
}

// The exact headers off a real scanned-post email (addresses are Kevin's own,
// which is the whole point of the case).
const POST_SCAN = {
  from: 'kevinbrittain@gmail.com',
  to: 'Kevin Brittain <kevinbrittain@gmail.com>',
  subject: 'POST: Companies House - first strike-off notice',
};

// A genuine reply Kevin sent to a third party. This MUST still count.
const REAL_REPLY = {
  from: 'Kevin Brittain <kevinbrittain@gmail.com>',
  to: 'Further Recovery <FurtherRecovery@angliarevenues.gov.uk>',
  subject: 'Re: Council Tax Accounts',
};

describe('a message addressed only to yourself is not an answer', () => {
  it('flags the real scanned-post shape', () => {
    expect(py(`print(json.dumps(m.self_addressed(${JSON.stringify(POST_SCAN)})))`)).toBe(true);
  });

  it('CONTROL — a genuine outbound reply is NOT flagged', () => {
    // If this ever flips, the check has stopped suppressing anything and 41%
    // of Kevin's rejections come straight back.
    expect(py(`print(json.dumps(m.self_addressed(${JSON.stringify(REAL_REPLY)})))`)).toBe(false);
  });

  it('CONTROL — a reply that copies Kevin in alongside someone else counts', () => {
    const cc = { ...REAL_REPLY, cc: 'kevinbrittain@gmail.com' };
    expect(py(`print(json.dumps(m.self_addressed(${JSON.stringify(cc)})))`)).toBe(false);
  });

  it('a send with no recipients at all cannot have answered anyone', () => {
    expect(py(`print(json.dumps(m.self_addressed({"from": "kevinbrittain@gmail.com"})))`)).toBe(true);
  });

  it('an unreadable From is not treated as self-addressed', () => {
    // Fail OPEN here: wrongly excluding a real send re-creates a task Kevin
    // already handled, which is noisy but recoverable.
    expect(py(`print(json.dumps(m.self_addressed({"to": "someone@example.com"})))`)).toBe(false);
    expect(py(`print(json.dumps(m.self_addressed(None)))`)).toBe(false);
  });

  it('address matching ignores display names and case', () => {
    const shouty = { from: 'KEVINBRITTAIN@GMAIL.COM', to: '"Kevin B" <kevinbrittain@gmail.com>' };
    expect(py(`print(json.dumps(m.self_addressed(${JSON.stringify(shouty)})))`)).toBe(true);
  });
});

describe('the sent map publishes what a reader needs to test "not that message"', () => {
  it('threadSends carries the message id next to the timestamp', () => {
    // A thread id alone cannot express "a DIFFERENT message from this one",
    // which is the whole bug.
    const body = SRC.match(/def cmd_sentcheck\(days\):([\s\S]*?)\ndef /)[1];
    expect(body).toContain('"threadSends": sends');
    expect(body).toMatch(/"id": m\.get\("id"\)/);
  });

  it('self-addressed sends are excluded AND counted, never silently dropped', () => {
    const body = SRC.match(/def cmd_sentcheck\(days\):([\s\S]*?)\ndef /)[1];
    expect(body).toContain('self_addressed(m.get("headers"))');
    expect(body).toContain('"selfAddressedExcluded": self_sent');
  });

  it('the empty-sent-folder control survives the change', () => {
    // Zero sends over a working week is a dead credential, not a quiet week.
    const body = SRC.match(/def cmd_sentcheck\(days\):([\s\S]*?)\ndef /)[1];
    expect(body).toContain('CONTROL FAILED');
    expect(body).toContain('SENTCHECK_MIN_DAYS_FOR_CONTROL');
  });
});

describe('the runner tells the agent both halves of the rule', () => {
  it('names the different-message test, not just "newer"', () => {
    expect(RUNNER).toContain('DIFFERENT message');
    expect(RUNNER).toContain('strictly greater');
  });

  it('says plainly that a message never answers itself', () => {
    expect(RUNNER).toMatch(/never answers itself/i);
  });
});
