import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SEND_LETTER = resolve(ROOT, 'scripts/send-letter.py');
const SRC = readFileSync(SEND_LETTER, 'utf8');

// The postal gate — scripts/send-letter.py.
//
// Pingen posts real paper and charges about GBP 2.50 a letter, and it has NO
// address parameter: the recipient is read off the PDF, out of the envelope
// window. Six HMRC letters were lost that way in Sept/Oct 2025, charged and
// returned "Not at this address" 24 days later, on a screen nobody watched.
//
// Two of the three checks below exist because of bugs found on 28 Aug 2026
// while testing the script against the live API with throwaway letters.
describe('send-letter.py postal gate', () => {
  it('passes its own offline selftest', () => {
    const out = execFileSync('python3', [SEND_LETTER, 'selftest'], { encoding: 'utf8' });
    expect(out).toContain("PASS HMRC 'To:' defect is caught");
    expect(out).toContain('PASS a reference line read as an address is caught');
    expect(out, 'a parser or address check regressed').not.toContain('FAIL ');
  });

  // BUG 1 (found by the selftest itself). normalise_address stripped all
  // punctuation before comparing, so "HM Revenue & Customs" read as a mismatch
  // against "HM Revenue and Customs" and a valid letter was refused. A gate
  // that cries wolf is the gate people learn to bypass.
  it('folds & and "and" together so a valid address is not refused', () => {
    const out = execFileSync('python3', [SEND_LETTER, 'selftest'], { encoding: 'utf8' });
    expect(out).toContain('PASS case and spacing differences still match');
    expect(SRC, 'the & fold was removed from normalise_address')
      .toMatch(/replace\("&",\s*" AND "\)/);
  });

  // BUG 2 (found against the live API). Uploading the same address block at
  // three heights showed 64mm from the top grades "valid", while 71mm grades
  // "action_required" with a WORD-PERFECT address. So the address comparison
  // alone would wave through a letter that cannot post. Worse, send was
  // written to accept status 'new', which Pingen never returns, so it would
  // have refused every good letter instead.
  //
  // Both commands must compare against PINGEN_OK_STATUS.
  it('refuses on Pingen status as well as on the address text', () => {
    expect(SRC).toMatch(/^PINGEN_OK_STATUS\s*=\s*"valid"$/m);
    const prepare = SRC.slice(SRC.indexOf('def cmd_prepare'), SRC.indexOf('def cmd_send'));
    const send = SRC.slice(SRC.indexOf('def cmd_send'), SRC.indexOf('def cmd_selftest'));
    expect(prepare, 'prepare no longer checks the Pingen status')
      .toContain('PINGEN_OK_STATUS');
    expect(send, 'send no longer checks the Pingen status')
      .toContain('PINGEN_OK_STATUS');
    expect(send, "send is back to checking for the status 'new', which Pingen never returns")
      .not.toMatch(/"new"|'new'/);
  });

  // The shape that makes the gate mean anything, mirrored from send-email.py:
  // the only source of a letter is an approved task, so there is nothing to
  // override.
  it('has no force flag and takes no address on the command line', () => {
    // Match a real argparse flag, not the word in prose: the epilog says
    // "There is no --force", and that sentence is the promise, not a breach.
    expect(SRC, 'an override flag was added')
      .not.toMatch(/add_argument\(\s*["']--(force|yes|no-verify|skip)/);
    expect(SRC, 'an address or recipient became a command-line argument')
      .not.toMatch(/add_argument\(\s*["']--(address|to|recipient|postcode)/);
    const send = SRC.slice(SRC.indexOf('def cmd_send'), SRC.indexOf('def cmd_selftest'));
    expect(send, 'send stopped requiring approval')
      .toMatch(/load_approved\(args\.task,\s*require_approval=True\)/);
  });

  // A letter cannot be unposted, so the duplicate guard is not a nicety.
  it('refuses to post the same task twice', () => {
    const send = SRC.slice(SRC.indexOf('def cmd_send'), SRC.indexOf('def cmd_selftest'));
    expect(send).toMatch(/already_sent\(args\.task\)/);
    expect(send).toMatch(/refusing to post it twice/i);
  });
});
