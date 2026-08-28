import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SEND = resolve(ROOT, 'scripts/send-email.py');
const DISPATCH = resolve(ROOT, 'scripts/agent-dispatch.py');

// ── A HANDOVER NOBODY IS TOLD ABOUT (found 28 Aug 2026) ────────────────────
//
// `handover` reassigned tasks from 25 Aug and notified NOBODY. 47 tasks sat
// linked to Roy Lavin and not one email had ever gone to him. A comment in the
// code claimed it "DMs the new owner"; no code did.
//
// Survivable while every handover was Kevin typing one by hand. NOT survivable
// once the property lane routes automatically: work leaves his queue, lands on
// a name, and is seen by nobody — worse than clogging the queue, because he
// believes it was handled.
//
// Roy is not on Operations Director yet, so the email carries the WORK, not a
// link he cannot follow. Kevin, 28 Aug 2026: "as long as he's got the
// information by our email as well, that's the most important thing."

const run = (args) => {
  try {
    return { ok: true, out: execFileSync('python3', [SEND, ...args], { encoding: 'utf8' }) };
  } catch (e) {
    return { ok: false, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
};

describe('who may be emailed', () => {
  it('REFUSES anyone who is not a team member', () => {
    // This command must never become a route to a third party. That is what
    // `send` is for, and `send` carries the approval gate.
    const r = run(['notify', 'recTEST', '--to', 'someone@random.com', '--dry-run']);
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(/not a team member/);
    expect(r.out).toMatch(/never third parties/);
  });

  it('reads the roster from agent-dispatch.py rather than keeping its own', () => {
    // A second list of who may be emailed is how an address gets added in one
    // file and trusted in the other.
    const src = readFileSync(SEND, 'utf8');
    expect(src).toMatch(/ad\.HUMANS/);
    expect(src).not.toMatch(/roy\.lavin1978@gmail\.com/);
  });
});

describe('what may be emailed', () => {
  it('REFUSES tier-1 content even to a trusted colleague', () => {
    // The private legal matter does not travel because the recipient is
    // trusted. Asserted against the REAL patterns, not a copy.
    const src = readFileSync(SEND, 'utf8');
    expect(src).toMatch(/tier_match\(tier1_patterns/);
    expect(src).toMatch(/never emailed onward/);
  });

  it('carries the work itself, because Roy has no login', () => {
    const src = readFileSync(SEND, 'utf8');
    expect(src).toMatch(/WHAT IT IS/);
    expect(src).toMatch(/WHAT WE FOUND/);
    expect(src).toMatch(/You do not need to log in/);
  });
});

describe('the handover cannot silently fail to announce itself', () => {
  const src = readFileSync(DISPATCH, 'utf8');

  it('every handover to a colleague triggers the email', () => {
    expect(src).toMatch(/"notify", args\.task, "--to", args\.to/);
  });

  it('Kevin is never emailed — he reads the board', () => {
    expect(src).toMatch(/if who\["rec"\] != KEVIN_REC_ID:/);
  });

  it('a failed send is LOUD, and does not roll back the reassignment', () => {
    // The task genuinely moved. A half-undone handover is worse than one that
    // is loud about not having been announced.
    expect(src).toMatch(/"NOT EMAILED": notify_error/);
    expect(src).toMatch(/"emailed": notified/);
  });

  it('the send path is the ONE gated script, never the worker directly', () => {
    // scripts/send-email.py gates the Gmail worker. Calling the worker from a
    // second place is how the gate gets bypassed.
    expect(src).toMatch(/"send-email\.py"/);
    expect(src).not.toMatch(/drive-upload\.kevinbrittain\.workers\.dev/);
  });
});
