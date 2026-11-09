import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WATCH = resolve(ROOT, 'scripts/signature-watch.js');

// "Once it comes back" was the one step of Kevin's workflow with nothing behind
// it. Every other stage worked and the chain broke in the middle: an agent could
// send a document for signature and never learn it had been signed, so the
// second gate never happened.
let dir, ledger;

function run(args, env = {}) {
  try {
    return { ok: true, out: execFileSync('node', [WATCH, ...args],
      { encoding: 'utf8', env: { ...process.env, SIGNATURE_WATCH_LEDGER: ledger, ...env } }) };
  } catch (e) {
    return { ok: false, out: (e.stdout || '') + (e.stderr || '') };
  }
}

beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'sigwatch-')); ledger = join(dir, 'watch.jsonl'); });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('signature-watch', () => {
  it('refuses a task id that is not an Airtable record', () => {
    const r = run(['register', '--task', 'nope', '--agreement', 'X', '--then', 'post']);
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(/Airtable record id/);
  });

  it('refuses registration with no agreement name', () => {
    const r = run(['register', '--task', 'recAAAAAAAAAAAAAA', '--then', 'post']);
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(/--agreement is required/);
  });

  it('tracks what is awaiting signature', () => {
    expect(run(['register', '--task', 'recBBBBBBBBBBBBBB',
      '--agreement', 'Letter of Authority HMRC', '--then', 'post']).ok).toBe(true);
    const status = JSON.parse(run(['status']).out);
    expect(status.awaitingSignature.map((a) => a.task)).toContain('recBBBBBBBBBBBBBB');
    expect(status.signedAndFiled).toHaveLength(0);
  });

  it('reports a real zero when nothing is registered', () => {
    const empty = join(dir, 'empty.jsonl');
    const out = JSON.parse(run(['poll'], { SIGNATURE_WATCH_LEDGER: empty }).out);
    expect(out.pending).toBe(0);
  });

  // THE CONTROL, back-tested. An empty Completed list is a legitimate answer
  // AND what a logged-out session looks like. If those are ever confused, this
  // watcher reports "nothing signed yet" for ever and the chain dies silently —
  // the same silent-zero that made the worker's Gmail endpoint useless for this
  // job (HTTP 200, zero messages, wrong mailbox).
  it('REFUSES rather than reporting an empty list when the page did not render', () => {
    const blank = join(dir, 'blank.html');
    writeFileSync(blank, '<!doctype html><title>not adobe</title><p>signed out</p>');
    const r = run(['poll'], {
      SIGNATURE_WATCH_URL: 'file://' + blank,
      SIGNATURE_WATCH_WAIT_MS: '500',
    });
    expect(r.ok, 'the poll accepted a page with no agreements nav').toBe(false);
    expect(r.out).toMatch(/did not render/);
    expect(r.out, 'the refusal must not read as "nothing signed yet"')
      .toMatch(/NOT "nothing signed yet"/);
  }, 60000);

  // Adobe is the record; the email is a notification. Guard the decision so a
  // future edit does not quietly switch to the easier, wrong source.
  it('watches Adobe, not Gmail', () => {
    const src = readFileSync(WATCH, 'utf8');
    expect(src).toMatch(/acrobat\.adobe\.com/);
    // Strip comments first: the header EXPLAINS why Gmail is the wrong source,
    // and a file documenting a decision must not fail the test enforcing it.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code, 'it switched to watching Gmail, which is a notification not a record')
      .not.toMatch(/gmail\/list|gmail_triage_key/);
  });

  it('names the downloaded file by task, not by Adobe filename', () => {
    const src = readFileSync(WATCH, 'utf8');
    expect(src).toMatch(/signed_\$\{item\.task\}/);
  });
});

// THE REGRESSION (20261014-defects-cleanup-881). On 14 Oct 2026 the audit-report append failed for
// task recP4BGhCqJUrIZYn and the note read only "Traceback (most recent call last): File
// .../adobe_audit.py, line 158". Python prints the exception LAST, so the old `.slice(0, 200)` kept
// the frames and cut off the one line saying what broke: the defect could not be diagnosed at all.
// Drives the real exported function; back-test by returning `stderr.trim().slice(0, 200)`, which
// fails the first case.
describe('a failed append says what went wrong, not just where (881)', () => {
  const { failureReason } = createRequire(import.meta.url)(WATCH);
  const TRACEBACK = [
    'Traceback (most recent call last):',
    '  File "/Users/x/scripts/adobe_audit.py", line 201, in <module>',
    '    main()',
    '  File "/Users/x/scripts/adobe_audit.py", line 158, in main',
    '    out, n = append_audit(signed, audit)',
    'ValueError: The length of the provided data is not a multiple of the block length.',
  ].join('\n');

  it('keeps the exception line from the end of a Python traceback', () => {
    const r = failureReason({ status: 1, stderr: TRACEBACK });
    expect(r).toContain('ValueError: The length of the provided data is not a multiple of the block length.');
    expect(r).toContain('line 158');
  });

  it('a traceback with no exception line still names the newest frame, never an empty reason', () => {
    const r = failureReason({ status: 1, stderr: 'Traceback (most recent call last):\n  File "a.py", line 3, in main' });
    expect(r).toContain('line 3');
    expect(r.trim()).not.toBe('');
  });

  // CONTROL: a script that fails with nothing on either stream must still give a reason. A blank note
  // is what sent this finding round the houses in the first place.
  it('no output at all is reported as the exit code, not as a blank note', () => {
    expect(failureReason({ status: 3, stderr: '', stdout: '' })).toBe('exited 3 with no output');
    expect(failureReason({ status: 2, stderr: '   \n\n' })).toBe('exited 2 with no output');
  });

  // CONTROL: a plain one-line error (adobe_audit.py's own sys.exit message) is passed through whole,
  // and the note stays short enough to live in a ledger row.
  it('a plain error message is passed through, and a long one is capped', () => {
    expect(failureReason({ status: 1, stderr: 'ERROR: no audit report in that PDF' }))
      .toBe('ERROR: no audit report in that PDF');
    expect(failureReason({ status: 1, stderr: 'E'.repeat(900) }).length).toBeLessThanOrEqual(300);
  });

  it('falls back to stdout when stderr is empty', () => {
    expect(failureReason({ status: 1, stderr: '', stdout: 'RuntimeError: pikepdf is not installed' }))
      .toBe('RuntimeError: pikepdf is not installed');
  });
});
