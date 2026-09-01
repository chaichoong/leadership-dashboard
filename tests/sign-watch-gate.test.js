// Guards the signature-watch completion gate (1 Sep 2026).
//
// A SIGN carry-out is only done when the signed copy can find its way back.
// On 28 Aug 2026 four letters of authority were "sent", their tasks completed,
// and the watcher's ledger read "nothing registered and unsigned" for four
// days while all four sat as Adobe drafts. `complete` now refuses a SIGN
// carry-out whose task has no register row in the watcher's OWN ledger.
import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { makeRunPy } from './helpers/dispatch-py.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DISPATCH = resolve(ROOT, 'scripts/agent-dispatch.py');
const src = readFileSync(DISPATCH, 'utf8');
const pyEval = makeRunPy(DISPATCH);

describe('sign_output_needs_watch — only a SIGN output arms the gate', () => {
  const SIGN = 'DOCUMENT: ~/knowledge-os/attachments/loa.pdf\nSIGNERS: ciara@example.com\n---\nWhat signing commits Kevin to.';
  const CASES = [
    [SIGN, true],
    ['TIER-1 BANNER LINE\n' + SIGN, true],                       // banner on top
    ['signers: a@b.com\n---\nlower-case header still counts', true],
    ['TO: someone@example.com\nFROM: kevin@example.com\nSUBJECT: x\n---\nBody.', false],
    ['POST:\nHMRC\nBX9 1AX\nDOCUMENT: ~/x.pdf\n---\nletter', false],  // post, no signers
    ['---\nSIGNERS: mentioned only in the body, not the header', false],
    ['', false],
  ];
  it('classifies the three correspondence shapes correctly', () => {
    const results = pyEval('[mod.sign_output_needs_watch(t) for t in arg]',
      CASES.map((c) => c[0]));
    CASES.forEach(([text, expected], i) =>
      expect(results[i], JSON.stringify(text.slice(0, 40))).toBe(expected));
  });
});

describe('signature_watch_registered — reads the watcher\'s OWN ledger', () => {
  it('finds a registered task, misses an unregistered one, survives junk and a missing file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'watch-gate-'));
    const ledger = join(dir, 'watch.jsonl');
    writeFileSync(ledger, [
      'not json at all',
      JSON.stringify({ cmd: 'register', task: 'recAAAAAAAAAAAAAA', agreement: 'loa' }),
      JSON.stringify({ cmd: 'signed', task: 'recBBBBBBBBBBBBBB' }),   // signed without register
    ].join('\n') + '\n');
    const out = pyEval(
      `(setattr(mod, "SIGNATURE_WATCH_LEDGER", arg["ledger"]) or ` +
      `[mod.signature_watch_registered(t) for t in arg["tasks"]])`,
      { ledger, tasks: ['recAAAAAAAAAAAAAA', 'recBBBBBBBBBBBBBB', 'recCCCCCCCCCCCCCC'] });
    expect(out).toEqual([true, false, false]);
    const missing = pyEval(
      `(setattr(mod, "SIGNATURE_WATCH_LEDGER", arg) or mod.signature_watch_registered("recAAAAAAAAAAAAAA"))`,
      join(dir, 'nowhere.jsonl'));
    expect(missing).toBe(false);
  });
});

describe('cmd_complete carries the gate (source contract)', () => {
  it('refuses an unwatched SIGN carry-out before either completion path', () => {
    const complete = src.slice(src.indexOf('def cmd_complete'),
                               src.indexOf('def cmd_verify'));
    expect(complete).toMatch(/sign_output_needs_watch\(t\["agentOutput"\]\)/);
    expect(complete).toMatch(/signature_watch_registered\(args\.task\)/);
    expect(complete).toMatch(/no signature watch is registered/);
    // The gate sits before the keep-open branch, so BOTH routes pass through it.
    expect(complete.indexOf('no signature watch is registered'))
      .toBeLessThan(complete.indexOf('if args.keep_open'));
  });
});
