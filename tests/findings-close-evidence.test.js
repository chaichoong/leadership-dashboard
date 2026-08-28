import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FINDINGS = resolve(ROOT, 'scripts/findings.py');

// Findings 20260820-agent-dispatch-262 and 20260820-queue-fixer-266.
//
// `close --outcome fixed` used to record an outcome and ask for no proof.
// Findings 201, 203, 204 and 237 were all closed as fixed on days when the files
// they named had ZERO commits and the function they claimed to add did not exist
// anywhere in the repo. Six approved creditor emails then failed to send on three
// consecutive runs while the queue read clean.
//
// The gate: `fixed` needs evidence, and a commit SHA is CHECKED — it must exist
// and be an ancestor of origin/main. A SHA that lives only on a branch is a fix
// sitting in an open PR, which is `pending`, not `fixed`.

function tmpQueue() {
  const dir = mkdtempSync(join(tmpdir(), 'findings-evidence-'));
  return join(dir, 'queue.jsonl');
}

function run(args, file) {
  const env = { ...process.env, FINDINGS_FILE: file };
  try {
    return { code: 0, out: execFileSync('python3', [FINDINGS, ...args], { encoding: 'utf8', env }) };
  } catch (e) {
    return { code: e.status, out: (e.stdout || '') + (e.stderr || '') };
  }
}

function seed(file) {
  const r = run(['add', '--routine', 'queue-fixer', '--title', 'a thing that broke',
    '--where', 'scripts/x.py:1', '--severity', 'high'], file);
  expect(r.code).toBe(0);
  const id = r.out.trim().split(/\s+/).find((t) => /^\d{8}-/.test(t));
  expect(id, `could not parse an id out of: ${r.out}`).toBeTruthy();
  return id;
}

function closes(file) {
  return readFileSync(file, 'utf8').trim().split('\n')
    .map((l) => JSON.parse(l)).filter((r) => r.op === 'close');
}

// A commit that is genuinely on origin/main, read from this checkout rather than
// hardcoded, so the test does not rot.
const LANDED_SHA = execFileSync('git', ['-C', ROOT, 'rev-parse', 'origin/main'], { encoding: 'utf8' }).trim();

describe('findings.py close — evidence gate', () => {
  it('BACK-TEST: fixed with a note and no evidence is REFUSED, and writes nothing', () => {
    const f = tmpQueue();
    const id = seed(f);
    // This is verbatim the shape that closed 201/203/204/237 with no code change.
    const r = run(['close', id, '--outcome', 'fixed', '--note', 'fixed the send gate'], f);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/REFUSED/);
    expect(r.out).toMatch(/--evidence/);
    expect(closes(f)).toEqual([]);
  });

  it('fixed with a SHA that is an ancestor of origin/main is accepted', () => {
    const f = tmpQueue();
    const id = seed(f);
    const r = run(['close', id, '--outcome', 'fixed', '--evidence', LANDED_SHA,
      '--note', 'landed'], f);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/evidence verified/);
    expect(closes(f)[0].evidence).toBe(LANDED_SHA);
  });

  it('a SHA that exists but is only on a branch is REFUSED and told to use pending', () => {
    const f = tmpQueue();
    const id = seed(f);
    // HEAD of this worktree: a real commit, not yet on origin/main.
    const branchOnly = execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    if (branchOnly === LANDED_SHA) return; // nothing committed here yet; nothing to prove
    const r = run(['close', id, '--outcome', 'fixed', '--evidence', branchOnly], f);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/not an ancestor of origin\/main/);
    expect(r.out).toMatch(/pending/);
    expect(closes(f)).toEqual([]);
  });

  it('a SHA that does not exist at all is REFUSED', () => {
    const f = tmpQueue();
    const id = seed(f);
    const r = run(['close', id, '--outcome', 'fixed', '--evidence', 'deadbeef1234567'], f);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/does not exist/);
  });

  it('non-code evidence is taken at its word, but must be said', () => {
    const f = tmpQueue();
    const id = seed(f);
    const r = run(['close', id, '--outcome', 'fixed',
      '--evidence', 'Airtable: cleared 143 rows, re-ran invariant, 0 violations'], f);
    expect(r.code).toBe(0);
    expect(closes(f)[0].evidence).toMatch(/143 rows/);
  });

  it('pending without --pr is REFUSED: a fix nobody can find is not a fix', () => {
    const f = tmpQueue();
    const id = seed(f);
    expect(run(['close', id, '--outcome', 'pending', '--note', 'in a PR'], f).code).not.toBe(0);
    expect(run(['close', id, '--outcome', 'pending', '--pr', '149', '--note', 'in a PR'], f).code).toBe(0);
  });

  it('rejected and deferred still need a reason, and need no evidence', () => {
    const f = tmpQueue();
    const a = seed(f);
    expect(run(['close', a, '--outcome', 'rejected'], f).code).not.toBe(0);
    expect(run(['close', a, '--outcome', 'rejected', '--note', 'could not reproduce'], f).code).toBe(0);

    const f2 = tmpQueue();
    const b = seed(f2);
    expect(run(['close', b, '--outcome', 'deferred', '--note', 'needs Kevin'], f2).code).toBe(0);
  });

  it('land still flips a pending finding to fixed', () => {
    const f = tmpQueue();
    const id = seed(f);
    expect(run(['close', id, '--outcome', 'pending', '--pr', '149', '--note', 'in #149'], f).code).toBe(0);
    expect(run(['land', '--pr', '149'], f).code).toBe(0);
    const rows = run(['list', '--json'], f).out;
    expect(JSON.parse(rows).find((r) => r.id === id).status).toBe('fixed');
  });
});
