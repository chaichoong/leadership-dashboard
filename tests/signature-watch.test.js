import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

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
