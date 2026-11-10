// The overflow log must be READ, not just written.
//
// WHY (8 Oct 2026, finding 20261008-phase-2-790)
// `findings.py add` refuses a medium from a routine already at its cap and
// appends it to findings-overflow.jsonl, telling the filer "nothing is lost".
// Nothing in the rotation ever opened that file. By 8 Oct it held 189 lines,
// three added the day before, one of them a rent-check fault lost by the
// 17:00 triage slot. Lost to the work, present on the disk.
//
// So `list` prints the backlog: count, oldest timestamp, path, oldest five.
// The guard below drives the real script and fails if the refused finding
// cannot be seen from `list` — stdout for a human, stderr for --json so the
// JSON keeps its shape for every caller.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const FINDINGS = resolve(__dirname, '../scripts/findings.py');
const ROOT = mkdtempSync(join(tmpdir(), 'findings-overflow-'));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

let file;
let overflow;
let n = 0;

function run(args, { capture = 'stdout' } = {}) {
  const res = execFileSync('python3', [FINDINGS, ...args], {
    env: { ...process.env, FINDINGS_FILE: file, FINDINGS_OVERFLOW_FILE: overflow },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return res;
}

function runCapturingBoth(args) {
  // execFileSync only returns stdout, so stderr is collected via a shell.
  return execFileSync('/bin/sh', ['-c',
    `python3 ${JSON.stringify(FINDINGS)} ${args.map((a) => JSON.stringify(a)).join(' ')} 2>&1`], {
    env: { ...process.env, FINDINGS_FILE: file, FINDINGS_OVERFLOW_FILE: overflow },
    encoding: 'utf8',
  });
}

beforeEach(() => {
  file = join(ROOT, `q${n}.jsonl`);
  overflow = join(ROOT, `o${n}.jsonl`);
  n += 1;
});

describe('findings.py list reads the overflow log', () => {
  it('a refused finding is visible from list, not only on disk', () => {
    // 16 mediums from one routine: the cap is 15, so the last is refused.
    for (let i = 0; i < 16; i += 1) {
      try {
        run(['add', '--routine', 'r-cap', '--title', `t-${i}`, '--severity', 'medium']);
      } catch { /* the refusal exits 2 — that is the behaviour under test */ }
    }
    const out = runCapturingBoth(['list', '--status', 'open']);
    expect(out, 'the overflow backlog is invisible from list')
      .toMatch(/OVERFLOW: \d+ finding\(s\) the cap refused/);
    expect(out, 'the refused title is never shown').toContain('t-15');
    expect(out, 'the path is not named, so nobody can go and read it')
      .toContain(overflow);
  });

  it('--json keeps a clean stdout and reports the backlog on stderr', () => {
    writeFileSync(overflow, `${JSON.stringify({
      op: 'overflow', ts: '2026-09-01T00:00:00Z', routine: 'r-x',
      severity: 'medium', title: 'a lost rent-check fault',
    })}\n`);
    const stdout = run(['list', '--status', 'open', '--json']);
    expect(() => JSON.parse(stdout), 'the overflow note corrupted the JSON on stdout')
      .not.toThrow();
    const both = runCapturingBoth(['list', '--status', 'open', '--json']);
    expect(both, 'the backlog never reached stderr either')
      .toContain('a lost rent-check fault');
  });

  it('no overflow file means no noise at all', () => {
    run(['add', '--routine', 'r-q', '--title', 'quiet', '--severity', 'high']);
    const both = runCapturingBoth(['list', '--status', 'open']);
    expect(both, 'an empty backlog still printed a banner').not.toContain('OVERFLOW:');
  });
});

// The count the morning report prints (finding 20261107-daily-ops-1238). `list`
// has shown the backlog since 8 Oct, but only to whoever reads the queue; the
// report Kevin's 09:00 brief is lifted from named the queue every day and never
// the 270 refusals beside it. `overflow count` is the machine-readable line that
// closes that, and its ONE rule is that an unreadable log is never a zero.
describe('findings.py overflow count, for the morning report (1238)', () => {
  const count = (json = false) => {
    const out = run(['overflow', 'count', ...(json ? ['--json'] : [])]);
    return json ? JSON.parse(out) : out.trim();
  };

  it('reports the refused count and the oldest date', () => {
    writeFileSync(overflow, [
      { op: 'overflow', ts: '2026-08-26T19:52:55Z', routine: 'r-a', severity: 'medium', title: 'the oldest' },
      { op: 'overflow', ts: '2026-11-01T08:00:00Z', routine: 'r-b', severity: 'low', title: 'a newer one' },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n');
    const j = count(true);
    expect(j.refused).toBe(2);
    expect(j.oldest).toBe('2026-08-26');
    expect(j.error).toBe('');
    expect(j.log).toBe(overflow);
    expect(count()).toMatch(/OVERFLOW: 2 refused and unsorted, oldest 2026-08-26\./);
  });

  it('an empty log says so plainly, and prints no count', () => {
    writeFileSync(overflow, '');
    expect(count(true).refused).toBe(0);
    expect(count()).toMatch(/nothing refused and unsorted/);
  });

  it('THE RULE: a log that cannot be OPENED is null, never zero', () => {
    // A number here would be a lie the report repeats every morning, and "0
    // refused" reads identically to a drained waiting room. Same reason
    // print_overflow refuses to invent one. A directory in the log's place is
    // the cheap way to make the open fail.
    mkdirSync(`${overflow}.d`, { recursive: true });
    const out = runCapturingBoth(['overflow', 'count', '--json',
      '--note', '']).trim();
    const j = JSON.parse(execFileSync('python3', [FINDINGS, 'overflow', 'count', '--json'], {
      env: { ...process.env, FINDINGS_FILE: file, FINDINGS_OVERFLOW_FILE: `${overflow}.d` },
      encoding: 'utf8',
    }));
    expect(j.refused, 'an unopenable log was counted as zero refusals').toBeNull();
    expect(j.error, 'the reason the log could not be read is not reported').toBeTruthy();
    expect(out.length).toBeGreaterThan(0);
  });

  it('a refusal whose own line is corrupt is still COUNTED, never dropped', () => {
    // The converse, and the more likely fault: one unparseable line must not
    // make a real refusal disappear from the count. It is visible, just not
    // readable, so it counts and the date reads unknown.
    writeFileSync(overflow, 'not json at all\n');
    const j = JSON.parse(run(['overflow', 'count', '--json']));
    expect(j.refused, 'a corrupt line silently dropped a refusal').toBe(1);
    expect(j.error).toBe('');
  });
});
