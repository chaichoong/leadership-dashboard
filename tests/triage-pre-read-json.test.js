// Every pre-read file the triage runner writes must hold JSON alone.
//
// Regression origin: 15-17 Oct 2026 (findings 20261015-agent-dispatch-914 and -919,
// 20261016-agent-dispatch-943, 20261016-inbound-email-triage-948 and -953 — one bug,
// five slots). The captures carried `2>&1` so a crash would land IN the file as an
// error object the skill reports loudly. That also swept the Gmail pacer's progress
// line, "GMAIL PACER: holding /gmail/list for 52.1s ...", in ahead of a complete and
// correct answer: json.load failed, the agent parsed past it by hand, and a reader
// following the skill would have read the whole sent check as UNCHECKED.
//
// These tests extract the real pre_read function out of the runner and run it under
// bash against stub commands. Back-tested: restoring `"$@" > "$out" 2>&1` makes the
// first two red.

import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const RUNNER = resolve(__dirname, '../scripts/inbound-triage-run.sh');
let helper;

beforeAll(() => {
  const src = readFileSync(RUNNER, 'utf8');
  // The function, verbatim out of the runner — never a copy maintained here.
  const start = src.indexOf('pre_read() {');
  expect(start, 'pre_read is gone from the runner').toBeGreaterThan(-1);
  const end = src.indexOf('\n}\n', start);
  expect(end).toBeGreaterThan(start);
  helper = src.slice(start, end + 3);
});

// Every capture in the runner goes through pre_read, not a bare redirect.
it('no pre-read still writes a scratch file with a bare redirect', () => {
  const src = readFileSync(RUNNER, 'utf8');
  const bare = src.split('\n').filter((l) => />\s*"\$SCRATCH\/[^"]+\.json"/.test(l) && !l.trim().startsWith('#'));
  expect(bare, `these still redirect straight into a scratch file: ${bare.join(' | ')}`).toEqual([]);
});

// The stub is a real executable, not a shell function: `exit 1` inside a function would
// end the driving shell, which is nothing the runner's own commands can do.
function runPreRead(stubBody, { after = '' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'preread-'));
  const out = join(dir, 'gmail-sent.json');
  const stub = join(dir, 'stub.sh');
  writeFileSync(stub, `#!/bin/bash\n${stubBody}\n`);
  chmodSync(stub, 0o755);
  const sh = join(dir, 'drive.sh');
  writeFileSync(sh, `${helper}\npre_read ${JSON.stringify(out)} ${JSON.stringify(stub)}\n${after}\n`);
  const stdout = execFileSync('bash', [sh], { encoding: 'utf8', timeout: 30000 });
  return { out, dir, stdout };
}

describe('triage pre-reads hold JSON alone', () => {
  it('keeps the pacer line out of the file when the command still answers', () => {
    const { out } = runPreRead(`echo "GMAIL PACER: holding /gmail/list for 52.1s to stay under the per-minute limit" >&2
echo '{"threadSendList":{"t1":[{"ts":1,"to":["a@b.c"]}]},"truncated":false}'`);
    const parsed = JSON.parse(readFileSync(out, 'utf8'));   // the whole point: it parses
    expect(parsed.truncated).toBe(false);
    expect(parsed.threadSendList.t1).toHaveLength(1);
    expect(parsed.error).toBeUndefined();
    // the noise is kept, just not in the JSON
    expect(readFileSync(`${out}.err`, 'utf8')).toContain('GMAIL PACER');
  });

  it('keeps the failure contract: a crash lands in the file as an error object', () => {
    const { out } = runPreRead(`echo "Traceback (most recent call last):" >&2
echo "RuntimeError: Gmail quota" >&2
exit 1`);
    const parsed = JSON.parse(readFileSync(out, 'utf8'));
    expect(parsed.error).toContain('did not produce JSON');
    expect(parsed.stderr).toContain('RuntimeError: Gmail quota');
  });

  it("a command's own error JSON is left exactly as it wrote it", () => {
    const { out } = runPreRead(`echo '{"error":"Gmail quota exhausted","threads":[]}'
exit 1`);
    const parsed = JSON.parse(readFileSync(out, 'utf8'));
    expect(parsed.error).toBe('Gmail quota exhausted');
    expect(parsed.stderr).toBeUndefined();
  });

  it('a pre-read never fails the slot', () => {
    const { out, stdout } = runPreRead('exit 3', { after: 'echo "the slot carried on"' });
    expect(existsSync(out)).toBe(true);
    expect(stdout).toContain('the slot carried on');
  });
});
