// THE POST THAT WAS ARCHIVED WITH NO EMAIL (finding 20260929-phase-3-660).
//
// The post-manager skill ran a bare `osascript ... send` per scanned document.
// Mail is not running on a freshly woken Mac, so AppleScript launched it and
// the FIRST send failed while it booted. Nothing read the exit code, and step 6
// moved the source PDF into Processed/ regardless — the document read as
// handled and no email existed anywhere.
//
// scripts/post-mail-send.sh is the fix, and this drives the real script with a
// stand-in for osascript: Mail is brought up first, a failed send is retried,
// and a send that never succeeded exits non-zero so the caller cannot archive.

import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(root, 'scripts/post-mail-send.sh');
const ROOT = mkdtempSync(join(tmpdir(), 'post-mail-'));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

/**
 * Runs the real script with fake osascript / Mail-running / open commands.
 *   failTimes  how many osascript calls fail before one succeeds
 *   running    whether Mail is up already, or the attempt it comes up on
 */
function run({ failTimes = 0, running = true, comesUpAfter = null, args = null } = {}) {
  const dir = mkdtempSync(join(ROOT, 'case-'));
  const pdf = join(dir, 'doc.pdf');
  const body = join(dir, 'body.txt');
  writeFileSync(pdf, '%PDF-1.4 fake');
  writeFileSync(body, 'Deadline: 2026-10-17\n\nThe PDF is attached.\n');

  // Fake osascript: records every call, fails the first `failTimes` of them.
  const calls = join(dir, 'calls.txt');
  const fakeOsa = join(dir, 'osascript');
  writeFileSync(fakeOsa, `#!/bin/bash
echo "call $*" >> ${JSON.stringify(calls)}
n=$(grep -c '^call' ${JSON.stringify(calls)})
if [ "$n" -le ${failTimes} ]; then echo "Mail got an error: application isn't running" >&2; exit 1; fi
exit 0
`);
  chmodSync(fakeOsa, 0o755);

  // Fake "is Mail running": either always, never, or from the Nth check on.
  const checks = join(dir, 'checks.txt');
  const fakeRun = join(dir, 'isrunning');
  writeFileSync(fakeRun, `#!/bin/bash
echo x >> ${JSON.stringify(checks)}
n=$(wc -l < ${JSON.stringify(checks)} | tr -d ' ')
${running ? 'exit 0'
  : comesUpAfter === null ? 'exit 1'
  : `[ "$n" -ge ${comesUpAfter} ] && exit 0 || exit 1`}
`);
  chmodSync(fakeRun, 0o755);

  const opened = join(dir, 'opened.txt');
  const fakeOpen = join(dir, 'openmail');
  writeFileSync(fakeOpen, `#!/bin/bash\necho opened >> ${JSON.stringify(opened)}\n`);
  chmodSync(fakeOpen, 0o755);

  const argv = args || [pdf, 'POST: Council - liability order', body];
  // spawnSync, not execFileSync: stderr is asserted on the SUCCESS paths too
  // (the Mail-boot lines), and execFileSync only hands it back on a throw.
  const r = spawnSync('bash', [SCRIPT, ...argv], {
    encoding: 'utf8',
    env: {
      ...process.env,
      POST_MAIL_OSASCRIPT: fakeOsa,
      POST_MAIL_ISRUNNING: fakeRun,
      POST_MAIL_OPEN: fakeOpen,
      POST_MAIL_WAIT_S: '0',
      POST_MAIL_BOOT_S: '4',
    },
  });
  const code = r.status, out = r.stdout || '', err = r.stderr || '';
  // Only the marker lines: the recorded argv carries the multi-line body too.
  const sends = existsSync(calls)
    ? readFileSync(calls, 'utf8').split('\n').filter((l) => l.startsWith('call ')).length : 0;
  return { code, out, err, sends, dir, pdf, body,
           openedMail: existsSync(opened) };
}

describe('post-mail-send.sh sends, retries, and never pretends', () => {
  it('sends once and exits 0 when Mail is already up', () => {
    const r = run();
    expect(r.code).toBe(0);
    expect(r.sends).toBe(1);
    expect(r.out).toMatch(/POST MAIL SENT on attempt 1\/3/);
    expect(r.openedMail).toBe(false);   // nothing to open
  });

  it('opens Mail and waits for it BEFORE the first send', () => {
    // THE BUG. The old inline osascript made the first send do the launching,
    // and that send failed.
    const r = run({ running: false, comesUpAfter: 2 });
    expect(r.code).toBe(0);
    expect(r.openedMail).toBe(true);
    expect(r.err).toMatch(/Mail is not running; opening it/);
    expect(r.err).toMatch(/Mail came up after \d+s/);
    expect(r.sends).toBe(1);
  });

  it('retries a failed send twice and reports which attempt worked', () => {
    const r = run({ failTimes: 2 });
    expect(r.code).toBe(0);
    expect(r.sends).toBe(3);
    expect(r.err).toMatch(/POST MAIL ATTEMPT 1\/3 FAILED/);
    expect(r.err).toMatch(/POST MAIL ATTEMPT 2\/3 FAILED/);
    expect(r.out).toMatch(/POST MAIL SENT on attempt 3\/3/);
  });

  it('exits non-zero when every attempt fails, and says the PDF must not be archived', () => {
    // The whole point: the caller keys the Processed/ move on this exit code.
    const r = run({ failTimes: 99 });
    expect(r.code).toBe(1);
    expect(r.sends).toBe(3);
    expect(r.err).toMatch(/POST MAIL NOT SENT after 3 attempts/);
    expect(r.err).toMatch(/must NOT be archived/);
    expect(r.out).not.toMatch(/SENT/);
  });

  it('says so when Mail never comes up, rather than waiting silently', () => {
    const r = run({ running: false, comesUpAfter: null });
    expect(r.err).toMatch(/Mail still not up after 4s; sending anyway/);
    expect(r.code).toBe(0);      // AppleScript may still launch it
  });

  it('refuses bad arguments and a missing attachment instead of mailing nothing', () => {
    expect(run({ args: [] }).code).toBe(2);
    const r = run({ args: ['/no/such/file.pdf', 'subject', '/no/such/body.txt'] });
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/no PDF at/);
    expect(r.sends).toBe(0);
  });
});

describe('the skill uses the script and gates the archive on it', () => {
  const skill = readFileSync(join(root, '.claude/scheduled-tasks/post-manager-weekly/SKILL.md'), 'utf8');

  it('calls post-mail-send.sh and no longer hand-rolls the send', () => {
    expect(skill).toMatch(/scripts\/post-mail-send\.sh/);
    // The bare inline send is what had no retry and no exit-code check.
    expect(skill).not.toMatch(/osascript -e 'tell application "Mail"/);
  });

  it('refuses to archive the source PDF while any send failed', () => {
    expect(skill).toMatch(/ONLY once every send returned 0/);
    expect(skill).toMatch(/do not move the source PDF and do not/);
  });
});
