// The CEO slot must not be recorded dead on a day it worked.
//
// WHY (findings 20261011-phase-2-828 and 20261012-phase-2-836, three days
// running; and 20260921-daily-ops-exceptions-557, closed deferred, 20 days of
// false reds before that)
// agent-slot-run.sh passes `LANE UNAVAILABLE` as a bare failure marker, so
// slot-postrun greps the log tail for that STRING regardless of what the
// sentence says about it. The CEO agent reports the ABSENCE of lane failures
// in words that contain the phrase, so a clean run tripped the marker:
//   11 Oct  "- **LANE UNAVAILABLE:** none. The Drive brain mount read ..."
//   12 Oct  "... so there are no LANE UNAVAILABLE lines."
// Both runs had rc=0 and both did their work (12 Oct's huddle wrote CEO Briefs
// row recSQbwjF5MgE86IK), yet job-status, estate-status and phase 1's guard all
// read the slot as dead. The cost is not cosmetic: 9 Oct carried a GENUINE lane
// loss and recorded the identical exit 1, so nothing downstream could tell a
// real ceo-agent failure from a healthy one.
//
// The fix is a TOLERATED_ERE (the mechanism slot-postrun has had since 16 Sep
// 2026), never a weakening of the marker itself — so an ASSERTED lane failure
// still fails the run, wherever in the line it appears.
import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = resolve(__dirname, '..');
const POSTRUN = resolve(ROOT, 'scripts/slot-postrun.sh');
const RUNNER = readFileSync(resolve(ROOT, 'scripts/agent-slot-run.sh'), 'utf8');

// Read the real patterns out of the runner's own slot-postrun call, so this
// test can never pass against a pattern the runner does not actually use.
function runnerPatterns() {
  const call = RUNNER.split('"$REPO/scripts/slot-postrun.sh"')[1];
  expect(call, 'agent-slot-run.sh no longer calls slot-postrun.sh').toBeTruthy();
  const quoted = [...call.matchAll(/'([^']*)'/g)].map((m) => m[1]);
  // leak_ere, bad_ere, tolerated_ere — in that order.
  expect(quoted.length, 'the runner passes no tolerated pattern, so a negated '
    + 'LANE UNAVAILABLE line still fails a clean run').toBeGreaterThanOrEqual(3);
  return { bad: quoted[1], tolerated: quoted[2] };
}

// Drive the real epilogue over a log tail, as the slot does.
function verdictFor(line) {
  const { bad, tolerated } = runnerPatterns();
  const base = mkdtempSync(join(tmpdir(), 'lane-marker-'));
  try {
    const repo = join(base, 'repo');
    const scratch = join(base, 'scratch');
    mkdirSync(join(repo, 'monitoring'), { recursive: true });
    mkdirSync(scratch, { recursive: true });
    const log = join(base, 'slot.log');
    const marker = join(base, 'marker');
    writeFileSync(log, `===== start =====\n${line}\n`);
    writeFileSync(marker, '');
    const r = spawnSync('bash', [POSTRUN, 'ceo-agent slot', '0', log, '1', marker, scratch,
      'NEVER_MATCHES_LEAK_PATTERN', bad, tolerated],
    { encoding: 'utf8', env: { ...process.env, SLOT_POSTRUN_REPO: repo } });
    return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

describe('agent-slot-run.sh lane marker', () => {
  // The exact lines the CEO agent wrote on the three days in question.
  const clean = [
    '- **LANE UNAVAILABLE:** none. The Drive brain mount read and wrote normally.',
    'All four heads read their own data, so there are no LANE UNAVAILABLE lines.',
    '15. No LANE UNAVAILABLE conditions.',
    'LANE UNAVAILABLE: none',
  ];
  const real = [
    'LANE UNAVAILABLE: dept-strategy - Airtable base refused',
    '- LANE UNAVAILABLE: dept-operations - Bash denied, could not curl Airtable',
  ];

  it.each(clean)('a run that reports no lane loss is OK: %s', (line) => {
    const { status, out } = verdictFor(line);
    expect(status, `the slot was recorded dead on a clean run: ${out}`).toBe(0);
    expect(out).toMatch(/run OK/);
  });

  it.each(real)('an ASSERTED lane failure still fails the run: %s', (line) => {
    const { status, out } = verdictFor(line);
    expect(status, `a real lane loss was tolerated: ${out}`).toBe(1);
    expect(out).toMatch(/failure markers/);
  });

  it('the other failure markers are untouched', () => {
    for (const line of ['HTTP Error 401 while reading the base',
      'VERIFY FAIL: the board row was never written',
      'BROKEN: the Drive mount is unreadable',
      'Chrome sourcing: SKIPPED, the tools are not loaded']) {
      expect(verdictFor(line).status, line).toBe(1);
    }
  });
});
