// A recurrence must carry its FIX text, not only the fact that it recurred.
//
// WHY (12 Oct 2026, finding 20261012-agent-dispatch-840)
// `findings.py add` folds a repeat sighting into the open finding as op=recur.
// It kept --detail as the note and threw --fix away, current_state kept only a
// counter, and `list` printed the ORIGINAL proposed_fix. So on 12 Oct finding
// 20261001-ceo-huddle-681 still showed its 30 Sep fix, while the cause found
// that morning (the Slack post running before storeBrief) survived only in a
// scratch file nothing reads. A fixer taking 681 would have shipped the 30 Sep
// fix, closed the finding as fixed, and left the live bug alone.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const FINDINGS = resolve(__dirname, '../scripts/findings.py');
const ROOT = mkdtempSync(join(tmpdir(), 'findings-recur-'));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

let file;
let n = 0;

function run(...args) {
  return execFileSync('python3', [FINDINGS, ...args], {
    env: { ...process.env, FINDINGS_FILE: file,
           FINDINGS_OVERFLOW_FILE: join(ROOT, 'overflow.jsonl') },
    encoding: 'utf8',
  }).trim();
}

beforeEach(() => { file = join(ROOT, `q${n++}.jsonl`); });

describe('findings.py — a later sighting keeps its own fix text', () => {
  it('prints the recurrence fix as well as the original', () => {
    const first = run('add', '--routine', 'ceo-huddle', '--title',
      'CEO brief never reached Kevin', '--severity', 'high',
      '--where', 'workers/money-daily-worker.js sendDailyDM',
      '--detail', 'the 30 Sep sighting',
      '--fix', 'STALE FIX: stop the duplicate fallback POST');
    const id = first.match(/([0-9]{8}-[a-z0-9-]+-[0-9]+)/)[1];

    // Same routine, same title, same place: this folds rather than filing new.
    const again = run('add', '--routine', 'ceo-huddle', '--title',
      'CEO brief never reached Kevin', '--severity', 'high',
      '--where', 'workers/money-daily-worker.js sendDailyDM',
      '--detail', 'the 12 Oct sighting: invalid_blocks thrown before storeBrief',
      '--fix', 'LIVE FIX: call storeBrief BEFORE slackPost');
    expect(again, 'a repeat sighting filed a second finding instead of folding')
      .toContain(id);

    const listed = run('list', '--status', 'open');
    expect(listed, 'the original fix vanished').toContain('STALE FIX');
    expect(listed, 'the recurrence fix was dropped, so the fixer reads a stale fix')
      .toContain('LIVE FIX: call storeBrief BEFORE slackPost');
  });

  it('carries every recurrence, with its note and fix, in --json', () => {
    const first = run('add', '--routine', 'phase-2', '--title', 'marker lies',
      '--severity', 'high', '--where', 'scripts/agent-slot-run.sh:155',
      '--detail', 'first', '--fix', 'fix one');
    const id = first.match(/([0-9]{8}-[a-z0-9-]+-[0-9]+)/)[1];
    run('add', '--routine', 'phase-2', '--title', 'marker lies',
      '--severity', 'high', '--where', 'scripts/agent-slot-run.sh:155',
      '--detail', 'second sighting', '--fix', 'fix two');

    const rows = JSON.parse(run('list', '--status', 'open', '--json'));
    const row = rows.find((r) => r.id === id);
    expect(row.seen).toBe(2);
    expect(row.recurrences, '--json callers cannot see the later fix')
      .toEqual([expect.objectContaining({ note: 'second sighting', fix: 'fix two' })]);
  });

  it('a recurrence filed with no fix adds no empty fix line', () => {
    const first = run('add', '--routine', 'phase-3', '--title', 'quiet repeat',
      '--severity', 'medium', '--where', 'scripts/content-engine/stab.py',
      '--detail', 'first', '--fix', 'the only fix');
    const id = first.match(/([0-9]{8}-[a-z0-9-]+-[0-9]+)/)[1];
    run('add', '--routine', 'phase-3', '--title', 'quiet repeat',
      '--severity', 'medium', '--where', 'scripts/content-engine/stab.py',
      '--detail', 'seen again, nothing new to propose');

    const listed = run('list', '--status', 'open');
    expect(listed).toContain('the only fix');
    expect(listed, 'an empty fix was printed as a blank line').not.toMatch(/fix \(added [^)]*\): *$/m);
    const row = JSON.parse(run('list', '--status', 'open', '--json'))
      .find((r) => r.id === id);
    expect(row.recurrences).toEqual([
      expect.objectContaining({ note: 'seen again, nothing new to propose', fix: '' }),
    ]);
  });
});
